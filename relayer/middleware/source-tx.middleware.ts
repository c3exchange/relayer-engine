/// <reference lib="dom" />
import { Middleware } from "../compose.middleware.js";
import { Context } from "../context.js";
import {
  CHAIN_ID_BSC,
  CHAIN_ID_SOLANA,
  ChainId,
  isEVMChain,
} from "@certusone/wormhole-sdk";
import { Logger } from "winston";
import { Environment } from "../environment.js";
import { LRUCache } from "lru-cache";
import { ParsedVaaWithBytes, defaultWormscanUrl } from "../application.js";
import { WormholescanClient } from "../rpc/wormholescan-client.js";
import { printError } from "../utils.js";

export interface SourceTxOpts {
  wormscanEndpoint: string;
  wormscanApiKey?: string;
  retries: number;
  initialDelay: number;
  maxDelay: number;
  timeout: number;
}

export interface SourceTxContext extends Context {
  sourceTxHash?: string;
}

const defaultOptsByEnv = {
  [Environment.MAINNET]: {
    wormscanEndpoint: defaultWormscanUrl[Environment.MAINNET],
    wormscanApiKey: undefined,
    retries: 5,
    initialDelay: 1_000,
    maxDelay: 45_000,
    timeout: 5_000,
  },
  [Environment.TESTNET]: {
    wormscanEndpoint: defaultWormscanUrl[Environment.TESTNET],
    wormscanApiKey: undefined,
    retries: 3,
    initialDelay: 1_000,
    maxDelay: 30_000,
    timeout: 3_000,
  },
  [Environment.DEVNET]: {
    wormscanEndpoint: defaultWormscanUrl[Environment.DEVNET],
    wormscanApiKey: undefined,
    retries: 3,
    initialDelay: 500,
    maxDelay: 10_000,
    timeout: 2_000,
  },
} satisfies { [k in Environment]: Partial<SourceTxOpts> };

function ifVAAFinalized(vaa: ParsedVaaWithBytes) {
  const { consistencyLevel, emitterChain } = vaa;
  if (emitterChain === CHAIN_ID_SOLANA) {
    return consistencyLevel === 32;
  } else if (emitterChain === CHAIN_ID_BSC) {
    return consistencyLevel > 15;
  }
  return consistencyLevel !== 200 && consistencyLevel !== 201;
}

let wormholescan: WormholescanClient;

export function sourceTx(
  optsWithoutDefaults?: SourceTxOpts,
): Middleware<SourceTxContext> {
  let opts: SourceTxOpts;
  const alreadyFetchedHashes = new LRUCache({ max: 1_000 });

  return async (ctx, next) => {
    if (!opts) {
      // initialize options now that we know the environment from context
      opts = {
        ...defaultOptsByEnv[ctx.env],
        ...optsWithoutDefaults,
      };
    }

    if (ctx.vaa === undefined) {
      ctx.logger?.debug("Didn't get a VAA id. Skipping tx hash fetch.");
      await next();
      return;
    }

    const vaaId = `${ctx.vaa.id.emitterChain}-${ctx.vaa.id.emitterAddress}-${ctx.vaa.id.sequence}`;
    const txHashFromCache = alreadyFetchedHashes.get(vaaId) as
      | string
      | undefined;

    if (txHashFromCache) {
      ctx.logger?.debug(`Already fetched tx hash: ${txHashFromCache}`);
      ctx.sourceTxHash = txHashFromCache;
      await next();
      return;
    }

    const { emitterChain, emitterAddress, sequence } = ctx.vaa;
    ctx.logger?.debug("Fetching tx hash...");
    let txHash = await fetchVaaHash(
      emitterChain,
      emitterAddress,
      sequence,
      ctx.env,
      ctx.logger,
      opts,
    );
    if (txHash === "") {
      ctx.logger?.debug("Could not retrieve tx hash.");
    } else {
      // TODO look at consistency level before using cache? (not sure what the checks are)
      if (ifVAAFinalized(ctx.vaa)) {
        alreadyFetchedHashes.set(vaaId, txHash);
      }
      ctx.logger?.debug(`Retrieved tx hash: ${txHash}`);
    }
    ctx.sourceTxHash = txHash;
    await next();
  };
}

export async function fetchVaaHash(
  emitterChain: number,
  emitterAddress: Buffer,
  sequence: bigint,
  env: Environment,
  logger?: Logger,
  sourceTxOpts?: SourceTxOpts,
) {
  if (!wormholescan) {
    const opts = sourceTxOpts || defaultOptsByEnv[env];
    wormholescan = new WormholescanClient(new URL(opts.wormscanEndpoint), {
      retries: opts.retries,
      initialDelay: opts.initialDelay,
      maxDelay: opts.maxDelay,
      timeout: opts.timeout,
      apiKey: opts.wormscanApiKey,
    });
  }

  const response = await wormholescan.getVaa(
    emitterChain,
    emitterAddress.toString("hex"),
    sequence,
  );

  if ("error" in response) {
    logger?.error(`Error fetching tx hash: ${printError(response.error)}`);
    throw response.error;
  }

  let txHash = response.data.txHash || "";

  if (
    isEVMChain(emitterChain as ChainId) &&
    txHash &&
    !txHash.startsWith("0x")
  ) {
    txHash = `0x${txHash}`;
  }

  logger?.debug("Source Transaction Hash: " + txHash || "Not Found");

  return txHash;
}
