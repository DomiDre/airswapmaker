import { Injectable } from '@angular/core';
import { AirswapService } from './airswap.service';
import { LogsService } from './logs.service';
import { Erc20Service } from './erc20.service';
import { HttpClient } from '@angular/common/http';
import { TimerObservable } from 'rxjs/observable/TimerObservable';

import { AppConfig } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class PriceService {
  public limitPrices = {};
  public balances = {};
  public expirationTime = 300;

  public balancesLimits = {};
  public balancesLiquidity = {};

  public openOrders = {};

  public usdPrices = {};
  public usdPricesByToken = {};

  public updateCountdown = 100;

  public priceUpdater;
  public algorithmRunning = false;
  public blacklistAddress = {};

  public algorithmCallbackOnUpdate = () => {};


  constructor(
    public airswapService: AirswapService,
    public erc20Service: Erc20Service,
    private logsService: LogsService,
    private http: HttpClient
  ) {
    this.startContinuousPriceBalanceUpdating();
  }

  startContinuousPriceBalanceUpdating() {
    if (!this.priceUpdater) {
      this.priceUpdater = TimerObservable.create(0, 100)
      .subscribe( () => {
        this.updateCountdown = this.updateCountdown + 100 / 30000 * 100;
        if (this.updateCountdown >= 100) {
          // if update countdown is at 100%, normally after 30s, refresh prices and your balances
          if (this.airswapService.connected) {
            this.getBalancesAndPrices()
            .then(() => {
              this.setPricingLogic();
            });
          }
        }
      });
    }
  }

  stopContinuousPriceBalanceUpdating() {
    this.priceUpdater.unsubscribe();
    this.priceUpdater = null;
  }

  startAlgorithm() {
    if (this.priceUpdater) {
      this.stopContinuousPriceBalanceUpdating();
    }
    this.algorithmRunning = true;
  }

  stopAlgorithm() {
    this.algorithmRunning = false;
  }

  setPricingLogic() {
    this.airswapService.asProtocol.RPC_METHOD_ACTIONS.getOrder = ((msg) => {
      const {
        makerAddress,
        makerAmount,
        makerToken,
        takerAddress,
        takerAmount,
        takerToken,
      } = msg.params;

      if (this.blacklistAddress[takerAddress]) {
        // ignore blacklisted addresses
        return;
      }
      console.log(msg);
      if (!makerAmount && !takerAmount) {
        // neither makerAmount nor takerAmount are set -> dont do anything.
        return;
      }
      if (makerAmount && takerAmount) {
        // both values are preset
        // we don't do that here
        return;
      }

      const makerProps = this.erc20Service.getToken(makerToken);
      const takerProps = this.erc20Service.getToken(takerToken);
      if (!makerProps || !takerProps) {
        // at least one of two tokens are not known to you -> don't do anything
        return;
      }

      // get current balances of the taker and the maker
      let takerMakerBalance = 0;
      let takerTakerBalance = 0;
      const promiseList = [];
      Promise.all([
        this.erc20Service.balance(makerToken, takerAddress)
        .then((balance) => {
          takerMakerBalance = balance;
        }),
        this.erc20Service.balance(takerToken, takerAddress)
        .then((balance) => {
          takerTakerBalance = balance;
        })
      ]).then(() => {
        // with the tokens & balances known, start making a response
        if (makerAmount) {
          this.logsService.addLog('Received order request from ' + takerAddress +
            ' to buy ' + makerAmount * (10 ** (-makerProps.decimals)) +
            ' ' + makerProps.symbol + ' with ' + takerProps.symbol);
        } else {
          this.logsService.addLog('Received order request from ' + takerAddress +
            ' to buy ' + makerProps.symbol + ' with ' +
            takerAmount * (10 ** (-takerProps.decimals)) + ' ' + takerProps.symbol);
        }

        // one is undefined of the two and will be filled in the next step
        let answerMakerAmount = makerAmount;
        let answerTakerAmount = takerAmount;

        // check if a limit price is set for the token pair
        if (this.limitPrices[makerToken] && this.limitPrices[makerToken][takerToken]) {
          if (makerAmount) {
            // Taker wants to buy a number of makerToken
            answerTakerAmount = this.erc20Service.toFixed(
              this.limitPrices[makerToken][takerToken] * makerAmount
            );
            this.logsService.addLog('Answering to sell for  ' +
              answerTakerAmount * (10 ** (-takerProps.decimals)) + ' ' +
              takerProps.symbol);
          } else {
            // Taker wants to sell a number of takerToken
            answerMakerAmount = this.erc20Service.toFixed(
              takerAmount / this.limitPrices[makerToken][takerToken]
            );
            this.logsService.addLog('Answering to buy for  ' +
              answerMakerAmount * (10 ** (-makerProps.decimals)) + ' ' +
              makerProps.symbol);
          }

          // check if both parties have enough balance
          if (takerTakerBalance < Number(answerTakerAmount)) {
            this.logsService.addLog('Cancelled. Counterparty only has ' +
              takerTakerBalance * (10 ** (-takerProps.decimals)) + ' ' +
              takerProps.symbol);
            return;
          }

          if (this.balancesLiquidity[makerToken] < Number(answerMakerAmount)) {
            this.logsService.addLog('Cancelled. Your liquid balance is only  ' +
            this.balancesLiquidity[makerToken] * (10 ** (-makerProps.decimals)) + ' ' +
              makerProps.symbol);
            return;
          }

          const expiration = Math.round(new Date().getTime() / 1000) + this.expirationTime;
          const nonce = String((Math.random() * 100000).toFixed());
          const signedOrder = this.airswapService.asProtocol.signOrder({
            makerAddress: this.airswapService.asProtocol.wallet.address.toLowerCase(),
            makerAmount: answerMakerAmount.toString(),
            makerToken,
            takerAddress,
            takerAmount: answerTakerAmount.toString(),
            takerToken,
            expiration,
            nonce,
          });

          // testmode, dont send it
          console.log('answer:', signedOrder);
          this.airswapService.asProtocol.call(
            takerAddress, // send order to address who requested it
            { id: msg.id, jsonrpc: '2.0', result: signedOrder }, // response id should match their `msg.id`
          );

          // store currently openOrder in a mapping for every maker Token
          if (!this.openOrders[makerToken]) {
            this.openOrders[makerToken] = {};
          }
          const signature = signedOrder.v + signedOrder.r + signedOrder.s;
          const expirationTimer = TimerObservable.create(0, 1000)
          .subscribe( () => {
            const currentTime = Math.round(new Date().getTime() / 1000);
            // find a way to check if this transaction was taken and mined
            if (currentTime > expiration) {
              // when expiration timer is up, end the timer and delete the order
              // update the balances and if a algorithm is running notify it
              // that something may have updated
              expirationTimer.unsubscribe();
              if (this.openOrders[makerToken][signature]) {
                delete this.openOrders[makerToken][signature];
                this.getBalancesAndPrices()
                .then(() => {
                  this.updateBalances(); // calculate the new liquid balances
                  if (this.algorithmRunning) {
                    this.algorithmCallbackOnUpdate();
                  }
                });
              }
            }
          });
          this.openOrders[makerToken][signature] = signedOrder;
          this.updateBalances();
        }
      });
    });
  }

  getPriceOfToken(tokenSymbol: string): Promise<any> {
    // http request to cryptocompare for current token prices
    return this.http.get(`https://min-api.cryptocompare.com/data/pricemulti?` +
    `fsyms=` + tokenSymbol + `&tsyms=USD`)
    .toPromise()
    .then((result) => {
      return result;
    });
  }

  getPricesOfList(tokenList: any): Promise<any> {
    // get prices for a bunch of cryptocurrencies in one call
    // warning: limited to ~50 tokens atm from the cryptocompare side
    // to do: consider case of > 50 tokens
    let tokenString = tokenList[0];
    for (let i = 1; i < tokenList.length; ++i) {
      const token = tokenList[i];
      tokenString = tokenString + ',' + token;
    }
    return this.getPriceOfToken(tokenString)
    .then(prices => {
      const usdPrices = {};
      for (const token of tokenList) {
        let priceToken = prices[token];
        if (!priceToken) {
          priceToken = null;
        } else {
          priceToken = priceToken['USD'];
        }
        usdPrices[token] = priceToken;
      }
      return usdPrices;
    });
  }

  setPrice(makerAddress: any, takerAddress: any, price: number) {
    if (price > 0) {
      if (!this.limitPrices[makerAddress]) {
        this.limitPrices[makerAddress] = {};
      }
      this.limitPrices[makerAddress][takerAddress] = price;
    }
  }

  removePriceOffer(makerToken, takerToken) {
    // function to remove answering requests of a certain token pair
    if (this.limitPrices[makerToken] &&
      this.limitPrices[makerToken][takerToken]) {
        delete this.limitPrices[makerToken][takerToken];
      }
  }

  getUsdPrices(): Promise<any> {
    this.updateCountdown = 0; // reset timer in any case, try not to have too many api calls to cryptocompare

    // make a list of all token symbols in the intents
    const tokenSymbolList = [];
    for (const tokenAddress of this.airswapService.tokenList) {
      tokenSymbolList.push(this.airswapService.tokenProps[tokenAddress].symbol);
    }
    return this.getPricesOfList(tokenSymbolList)
    .then((usdPrices) => {

      // crypto compare doesnt know WETH prices
      usdPrices['WETH'] = usdPrices['ETH'];
      this.usdPrices = usdPrices;
      // make a mapping token -> price for further use
      for (const token of this.airswapService.tokenList) {
        this.usdPricesByToken[token] = this.usdPrices[this.airswapService.tokenProps[token].symbol];
      }

      // note every price relative to the tokens within the intents itself
      for (const intent of this.airswapService.intents) {
        if (intent.makerProps && intent.takerProps
            && this.usdPrices[intent.makerProps.symbol] && this.usdPrices[intent.takerProps.symbol]) {
          intent.price = this.usdPrices[intent.makerProps.symbol] / this.usdPrices[intent.takerProps.symbol]
                          * intent.takerProps.powerDecimals / intent.makerProps.powerDecimals;
        }
      }
    });
  }

  getBalances(): Promise<any> {
    const promiseList = [];
    const newBalances = {};

    for (const token of this.airswapService.tokenList) {
      promiseList.push(
        this.erc20Service.balance(token, this.airswapService.asProtocol.wallet.address)
        .then((balance) => {
          newBalances[token] = balance;
        })
      );
    }
    return Promise.all(promiseList).then(() => {
      this.balances = newBalances;
      this.updateBalances();
    });
  }

  updateBalances(): void {
    const balancesLiquidity = {};
    for (const token of this.airswapService.tokenList) {
      // liquid balance cant be more than the actual balance, limit cant be higher than the actual balance
      if (this.balances[token] !== undefined && this.balancesLimits[token] !== undefined) {
        balancesLiquidity[token] = Math.min(this.balancesLimits[token], this.balances[token]);
      }

      // if there are open orders takers can take, consider them as taken while they are open
      if (this.openOrders[token]) {
        for (const signature in this.openOrders[token]) {
          if (this.openOrders[token][signature]) {
            balancesLiquidity[token] -= this.openOrders[token][signature].makerAmount;
          }
        }
      }
    }
    this.balancesLiquidity = balancesLiquidity;
  }

  getBalancesAndPrices(): Promise<any> {
    const promiseList = [];
    promiseList.push(this.getUsdPrices());
    promiseList.push(this.getBalances());
    return Promise.all(promiseList);
  }
}
