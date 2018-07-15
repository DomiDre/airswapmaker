import { Component, OnInit, OnDestroy } from '@angular/core';
import { AirswapService } from '../../services/airswap.service';
import { Erc20Service } from '../../services/erc20.service';
import { PriceService } from '../../services/price.service';

import { TimerObservable } from 'rxjs/observable/TimerObservable';

@Component({
  selector: 'app-price',
  templateUrl: './price.component.html',
  styleUrls: ['./price.component.scss']
})
export class PriceComponent implements OnInit, OnDestroy {

  public enteredPrices = {};
  public usdPrices = {};

  public updateCountdown = 100;
  public priceUpdater;

  public enteredExpiration: number;

  constructor(
    public airswapService: AirswapService,
    public erc20Service: Erc20Service,
    public priceService: PriceService,
  ) {
    this.enteredExpiration = Math.floor(this.priceService.expirationTime / 60);
  }

  ngOnInit() {
    this.airswapService.getIntents()
    .then(() => {
      for (const intent of this.airswapService.intents) {
        const makerProps = this.erc20Service.getToken(intent.makerToken.toLowerCase());
        const takerProps = this.erc20Service.getToken(intent.takerToken.toLowerCase());
        if (makerProps && takerProps) {
          intent.makerProps = makerProps;
          intent.takerProps = takerProps;
          intent.makerDecimals = 10 ** makerProps.decimals;
          intent.takerDecimals = 10 ** takerProps.decimals;

          if (intent.makerProps && intent.takerProps) {
            if (this.priceService.limitPrices[makerProps.address] &&
              this.priceService.limitPrices[makerProps.address][takerProps.address]) {
              this.enteredPrices[makerProps.address + takerProps.address] =
                this.priceService.limitPrices[makerProps.address][takerProps.address]
                * 10 ** (makerProps.decimals - takerProps.decimals);
            }
          }
        }
      }
      this.priceUpdater = TimerObservable.create(0, 100)
      .subscribe( () => {
        this.updateCountdown = this.updateCountdown + 100 / 30000 * 100;
        if (this.updateCountdown >= 100) {
          this.getUsdPrices();
        }
      });
      this.priceService.setPricingLogic();
    });
  }

  ngOnDestroy() {
    if (this.priceUpdater) {
      this.priceUpdater.unsubscribe();
    }
  }

  getUsdPrices(): Promise<any> {
    this.updateCountdown = 0;
    const tokenSymbolList = [];
    for (const intent of this.airswapService.intents) {
      if (intent.makerProps && intent.takerProps) {
        if (!(tokenSymbolList.indexOf(intent.makerProps.symbol) >= 0)) {
          tokenSymbolList.push(intent.makerProps.symbol);
        }
        if (!(tokenSymbolList.indexOf(intent.takerProps.symbol) >= 0)) {
          tokenSymbolList.push(intent.takerProps.symbol);
        }
      }
    }

    return this.priceService.getPricesOfList(tokenSymbolList)
    .then((usdPrices) => {
      this.usdPrices = usdPrices;
      for (const intent of this.airswapService.intents) {
        if (intent.makerProps && intent.takerProps) {
          intent.price = this.usdPrices[intent.makerProps.symbol] / this.usdPrices[intent.takerProps.symbol];
        }
      }
    });
  }

  priceValid(price: number): boolean {
    if (!price) {
      return false;
    } else {
      return price > 0;
    }
  }

  setPrice(makerProps: any, takerProps: any, price: number) {
    if (this.priceValid(price)) {
      if (!this.priceService.limitPrices[makerProps.address]) {
        this.priceService.limitPrices[makerProps.address] = {};
      }
      this.priceService.limitPrices[makerProps.address][takerProps.address] =
        price * 10 ** (takerProps.decimals - makerProps.decimals);
      this.priceService.setPricingLogic();
    }
  }

  setExpiration() {
    if (this.enteredExpiration > 0) {
      this.priceService.expirationTime = Math.floor(this.enteredExpiration * 60);
    }
  }

}
