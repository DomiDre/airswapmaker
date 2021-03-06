import { Component, OnInit } from '@angular/core';
import { Token } from '../../types/types';
import { AirswapService } from '../../services/airswap.service';
import { Erc20Service } from '../../services/erc20.service';
import { PriceService } from '../../services/price.service';
import { MatDialog } from '@angular/material';
import { AddTokenComponent } from '../../dialogs/add-token/add-token.component';
import { AskGasPriceApprovalComponent } from './ask-gas-price-approval/ask-gas-price-approval.component';
import { AppConfig } from '../../../environments/environment';

import * as ethers from 'ethers';

@Component({
  selector: 'app-intents',
  templateUrl: './intents.component.html',
  styleUrls: ['./intents.component.scss']
})
export class IntentsComponent implements OnInit {
  public makerToken: Token;
  public takerToken: Token;

  public markedIntents = false;
  public intentsMarkedForRemoval: any;

  public unapprovedTokens: any[] = [];
  public clickedApprove = {};

  public astBalance = 0;
  public remainingIntents: number;
  public balanceTooLow = true;

  public errorMessage = '';
  public showBuyButton = false;
  public initialized = false;

  public makerTokenName;
  public rawFilteredValidatedMakerTokens;
  public filteredValidatedMakerTokens;
  public takerTokenName;
  public rawFilteredValidatedTakerTokens;
  public filteredValidatedTakerTokens;

  public makerDecimals: number;
  public takerDecimals: number;

  public balanceMakerToken: number;
  public balanceTakerToken: number;

  public approveHashes = {};

  public provider;
  public etherscanAddress = AppConfig.etherscanAddress;

  constructor(
    public airswapService: AirswapService,
    public erc20Service: Erc20Service,
    private priceService: PriceService,
    public dialog: MatDialog,
  ) { }

  ngOnInit() {
    this.provider = ethers.providers.getDefaultProvider();
    this.filteredValidatedMakerTokens = this.erc20Service.tokenList;
    this.filteredValidatedTakerTokens = this.erc20Service.tokenList;
    this.initialize();
    this.checkIfIntentsArePending();
  }

  initialize(): void {
    this.getIntents()
    .then(() => {
      this.getAstBalance();
    });
  }

  checkIfIntentsArePending(): void {
    for (const token in this.airswapService.tokensInApprovalPending) {
      if (this.airswapService.tokensInApprovalPending[token]) {
        this.waitForApprovalTransaction(
          token,
          this.airswapService.tokensInApprovalPending[token]
        );
      }
    }
  }

  getIntents(): Promise<any> {
    if (this.airswapService.connected && this.airswapService.isAuthenticated) {
      return this.airswapService.getIntents()
      .then(() => {
        this.intentsMarkedForRemoval = [];
        for (const intent of this.airswapService.intents) {
          const makerProps = this.erc20Service.getToken(intent.makerToken.toLowerCase());
          const takerProps = this.erc20Service.getToken(intent.takerToken.toLowerCase());
          intent.makerProps = makerProps;
          intent.takerProps = takerProps;
        }
        this.checkApproval();
      });
    } else {
      return Promise.resolve();
    }
  }

  getAstBalance(): void {
    this.erc20Service.balance(
      AppConfig.astAddress,
      this.airswapService.asProtocol.wallet.address
    ).then(balance => {
      this.astBalance = balance / 1e4;
      this.balanceTooLow = this.astBalance - 250 * this.airswapService.intents.length < 250;
      this.remainingIntents = Math.floor((this.astBalance - 250 * this.airswapService.intents.length) / 250);
      this.initialized = true;
    });
  }

  enteredMakerTokenName(): void {
    this.filteredValidatedMakerTokens = this.erc20Service.tokenList.filter(x => {
      return x.name.toLowerCase().includes(this.makerTokenName.toLowerCase())
      || x.symbol.toLowerCase().includes(this.makerTokenName.toLowerCase());
    });

    const token = this.erc20Service.getTokenByName(this.makerTokenName);
    if (token) {
      this.makerToken = token;
      this.makerDecimals = 10 ** this.makerToken.decimals;
      this.getMakerTokenBalance();
    }
  }

  enteredTakerTokenName(): void {
    this.filteredValidatedTakerTokens = this.erc20Service.tokenList.filter(x => {
      return x.name.toLowerCase().includes(this.takerTokenName.toLowerCase())
      || x.symbol.toLowerCase().includes(this.takerTokenName.toLowerCase());
    });

    const token = this.erc20Service.getTokenByName(this.takerTokenName);
    if (token) {
      this.takerToken = token;
      this.takerDecimals = 10 ** this.takerToken.decimals;
      this.getTakerTokenBalance();
    }
  }

  findIdxOfIntent(intent, intentList): number {
    return intentList.findIndex(x => {
      return (x.makerToken === intent.makerToken
           && x.takerToken === intent.takerToken);
    });
  }

  isIntentInList(intent): any {
    return this.airswapService.intents.find(x => {
      return (x.makerToken === intent.makerToken
           && x.takerToken === intent.takerToken);
    });
  }

  changedList(event): void {
    this.markedIntents = event.length > 0;
  }

  addTokenPair(): void {
    if (this.makerToken
    && this.takerToken
    && this.makerToken.address !== this.takerToken.address
    && !this.balanceTooLow
    && !this.priceService.algorithmRunning) {
      const intent = {
        'makerToken': this.makerToken.address.toLowerCase(),
        'takerToken': this.takerToken.address.toLowerCase(),
        'role': 'maker'
      };
      if (!this.isIntentInList(intent)) {
        this.airswapService.intents.push(intent);
        this.airswapService.setIntents(this.airswapService.intents)
        .then(() => {
          this.initialize();
        });
      }
    }
  }

  tokenSymbol(tokenAddress: string): string {
    const token = this.erc20Service.getToken(tokenAddress.toLowerCase());
    if (token) {
      return token.symbol;
    } else {
      return null;
    }
  }

  removeMarkedIntents(): void {
    if (!this.priceService.algorithmRunning) {
      const newIntentList = JSON.parse(JSON.stringify(this.airswapService.intents));
      // removed marked intents
      for (const intent of this.intentsMarkedForRemoval) {
        const idx = this.findIdxOfIntent(intent, newIntentList);
        if (idx >= 0) {
          newIntentList.splice( idx, 1 );
          this.priceService.removeAmountLimit(intent.makerToken, intent.takerToken);
          this.priceService.removePriceOffer(intent.makerToken, intent.takerToken);
        }
      }
      this.markedIntents = false;
      this.airswapService.setIntents(newIntentList)
      .then(() => {
        this.initialize();
      });
    }
  }

  checkApproval(): void {
    this.unapprovedTokens = [];
    for (const intent of this.airswapService.intents) {
      if (intent.makerToken) {
        const contract = this.erc20Service.getContract(intent.makerToken);
        this.airswapService.approvedAmountAirSwap(contract)
        .then(approvedAmount => {
          if (!(approvedAmount > 0)
              && !this.unapprovedTokens.find(x => x === intent.makerToken) ) {
            this.unapprovedTokens.push(intent.makerToken);
          }
        }).catch(error => {
          console.log('Could not fetch the approval amount of ' + intent.makerToken);
        });
      }
    }
  }

  waitForApprovalTransaction(token, hash): Promise<any> {
    return this.provider.waitForTransaction(hash)
    .then((transaction) => {
      console.log('mined', transaction);
      if (this.airswapService.tokensInApprovalPending[token]) {
        delete this.airswapService.tokensInApprovalPending[token];
      }
      const index = this.unapprovedTokens.indexOf(token);
      if (index > -1) {
        this.unapprovedTokens.splice(index, 1);
      }
      if (this.clickedApprove[token]) {
        delete this.clickedApprove[token];
      }
    }).catch(error => {
      console.log('Approve failed.');
      if (this.clickedApprove[token]) {
        delete this.clickedApprove[token];
      }
    });
  }

  approveMaker(makerToken: string): void {
    const dialogRef = this.dialog.open(AskGasPriceApprovalComponent, {
      width: '500px'
    });

    dialogRef.afterClosed().subscribe(gasPrice => {
      if (gasPrice) {
        this.clickedApprove[makerToken] = true;
        this.airswapService.approve(makerToken, gasPrice)
        .then((hash) => {
          return this.waitForApprovalTransaction(makerToken, hash);
        });
      }
    });
  }

  filterEther(token: any) {
    return token.address !== '0x0000000000000000000000000000000000000000';
  }

  getMakerTokenBalance(): void {
    this.erc20Service.balance(this.makerToken.address, this.airswapService.asProtocol.wallet.address)
    .then(balance => {
      this.balanceMakerToken = balance;
    })
    .catch(error =>
      console.log('Error fetching the balance of ' + this.airswapService.asProtocol.wallet.address +
        ' for contract ' + this.makerToken.address)
    );
  }

  getTakerTokenBalance(): void {
    this.erc20Service.balance(this.takerToken.address, this.airswapService.asProtocol.wallet.address)
    .then(balance => {
      this.balanceTakerToken = balance;
    })
    .catch(error =>
      console.log('Error fetching the balance of ' + this.airswapService.asProtocol.wallet.address +
        ' for contract ' + this.takerToken.address)
    );
  }

  clearMakerTokenName(): void {
    this.makerTokenName = '';
    this.enteredMakerTokenName();
  }

  clearTakerTokenName(): void {
    this.takerTokenName = '';
    this.enteredTakerTokenName();
  }

  addToken(): void {
    const dialogRef = this.dialog.open(AddTokenComponent, {
      width: '500px'
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        this.filteredValidatedMakerTokens = this.erc20Service.tokenList;
        this.filteredValidatedTakerTokens = this.erc20Service.tokenList;
        this.initialize();
      }
    });
  }
}
