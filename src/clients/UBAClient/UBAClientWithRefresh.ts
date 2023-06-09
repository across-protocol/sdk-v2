import assert from "assert";
import winston from "winston";
import { BigNumber } from "ethers";
import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock, UbaFlow } from "../../interfaces";
import { HubPoolClient, SpokePoolClient } from "..";
import { isDefined, sortEventsAscending } from "../../utils";
import { BaseUBAClient, RequestValidReturnType } from "./UBAClientAbstract";

export class UBAClientWithRefresh extends BaseUBAClient {
  // @dev chainIdIndices supports indexing members of root bundle proposals submitted to the HubPool.
  //      It must include the complete set of chain IDs ever supported by the HubPool.
  // @dev SpokePoolClients may be a subset of the SpokePools that have been deployed.
  constructor(
    chainIdIndices: number[],
    private readonly hubPoolClient: HubPoolClient,
    private readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    logger?: winston.Logger
  ) {
    super(chainIdIndices, logger);
    assert(chainIdIndices.length > 0, "No chainIds provided");
    assert(Object.values(spokePoolClients).length > 0, "No SpokePools provided");
  }

  protected resolveClosingBlockNumber(chainId: number, blockNumber: number): number {
    return this.hubPoolClient.getLatestBundleEndBlockForChain(this.chainIdIndices, blockNumber, chainId);
  }

  public getOpeningBalance(
    chainId: number,
    spokePoolToken: string,
    hubPoolBlockNumber?: number
  ): { blockNumber: number; spokePoolBalance: BigNumber } {
    if (!isDefined(hubPoolBlockNumber)) {
      // todo: Fix this type assertion.
      hubPoolBlockNumber = this.hubPoolClient.latestBlockNumber as number;
    }

    const hubPoolToken = this.hubPoolClient.getL1TokenCounterpartAtBlock(chainId, spokePoolToken, hubPoolBlockNumber);
    if (!isDefined(hubPoolToken)) {
      throw new Error(`Could not resolve ${chainId} token ${spokePoolToken} at block ${hubPoolBlockNumber}`);
    }

    const spokePoolClient = this.spokePoolClients[chainId];
    const prevEndBlock = this.resolveClosingBlockNumber(chainId, hubPoolBlockNumber);
    let blockNumber = spokePoolClient.deploymentBlock;
    if (prevEndBlock > blockNumber) {
      blockNumber = prevEndBlock + 1;
      assert(blockNumber <= spokePoolClient.latestBlockNumber);
    }
    const { runningBalance: spokePoolBalance } = this.hubPoolClient.getRunningBalanceBeforeBlockForChain(
      hubPoolBlockNumber,
      chainId,
      hubPoolToken
    );

    return { blockNumber, spokePoolBalance };
  }

  public getFlows(chainId: number, fromBlock?: number, toBlock?: number): UbaFlow[] {
    const spokePoolClient = this.spokePoolClients[chainId];

    fromBlock = fromBlock ?? spokePoolClient.deploymentBlock;
    toBlock = toBlock ?? spokePoolClient.latestBlockNumber;

    // @todo: Fix these type assertions.
    const deposits: UbaFlow[] = spokePoolClient
      .getDeposits()
      .filter(
        (deposit: DepositWithBlock) =>
          deposit.blockNumber >= (fromBlock as number) && deposit.blockNumber <= (toBlock as number)
      );

    // Filter out:
    // - Fills that request refunds on a different chain.
    // - Subsequent fills after an initial partial fill.
    // - Slow fills.
    const fills: UbaFlow[] = spokePoolClient.getFills().filter((fill: FillWithBlock) => {
      const result =
        fill.repaymentChainId === spokePoolClient.chainId &&
        fill.fillAmount.eq(fill.totalFilledAmount) &&
        fill.updatableRelayData.isSlowRelay === false &&
        fill.blockNumber > (fromBlock as number) &&
        fill.blockNumber < (toBlock as number);
      return result;
    });

    const refundRequests: UbaFlow[] = spokePoolClient.getRefundRequests(fromBlock, toBlock).filter((refundRequest) => {
      const result = this.refundRequestIsValid(chainId, refundRequest);
      if (!result.valid && this.logger !== undefined) {
        this.logger.info({
          at: "UBAClient::getFlows",
          message: `Excluding RefundRequest on chain ${chainId}`,
          reason: result.reason,
          refundRequest,
        });
      }

      return result.valid;
    });

    // This is probably more expensive than we'd like... @todo: optimise.
    const flows = sortEventsAscending(deposits.concat(fills).concat(refundRequests));

    return flows;
  }

  public refundRequestIsValid(chainId: number, refundRequest: RefundRequestWithBlock): RequestValidReturnType {
    const { relayer, amount, refundToken, depositId, originChainId, destinationChainId, realizedLpFeePct, fillBlock } =
      refundRequest;

    if (!this.chainIdIndices.includes(originChainId)) {
      return { valid: false, reason: "Invalid originChainId" };
    }
    const originSpoke = this.spokePoolClients[originChainId];

    if (!this.chainIdIndices.includes(destinationChainId) || destinationChainId === chainId) {
      return { valid: false, reason: "Invalid destinationChainId" };
    }
    const destSpoke = this.spokePoolClients[destinationChainId];

    if (fillBlock.lt(destSpoke.deploymentBlock) || fillBlock.gt(destSpoke.latestBlockNumber)) {
      return {
        valid: false,
        reason:
          `FillBlock (${fillBlock} out of SpokePool range` +
          ` [${destSpoke.deploymentBlock}, ${destSpoke.latestBlockNumber}]`,
      };
    }

    // Validate relayer and depositId.
    const fill = destSpoke.getFillsForRelayer(relayer).find((fill) => {
      // prettier-ignore
      return (
        fill.depositId === depositId
        && fill.originChainId === originChainId
        && fill.destinationChainId === destinationChainId
        && fill.amount.eq(amount)
        && fill.realizedLpFeePct.eq(realizedLpFeePct)
        && fill.blockNumber === fillBlock.toNumber()
      );
    });
    if (!isDefined(fill)) {
      return { valid: false, reason: "Unable to find matching fill" };
    }

    const deposit = originSpoke.getDepositForFill(fill);
    if (!isDefined(deposit)) {
      return { valid: false, reason: "Unable to find matching deposit" };
    }

    // Verify that the refundToken maps to a known HubPool token.
    // Note: the refundToken must be valid at the time of the Fill *and* the RefundRequest.
    // @todo: Resolve to the HubPool block number at the time of the RefundRequest ?
    const hubPoolBlockNumber = this.hubPoolClient.latestBlockNumber ?? this.hubPoolClient.deploymentBlock - 1;
    try {
      this.hubPoolClient.getL1TokenCounterpartAtBlock(chainId, refundToken, hubPoolBlockNumber);
    } catch {
      return { valid: false, reason: `Refund token unknown at HubPool block ${hubPoolBlockNumber}` };
    }

    return { valid: true };
  }
}