// import { Struct } from "superstruct";
// import { CachingMechanismInterface } from "../../interfaces";
import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet";
import { ethers } from "ethers";
import winston from "winston";
import { jsonReplacerWithBigNumbers, parseWinston } from "../../utils";
import { Struct, is } from "superstruct";

export class ArweaveClient {
  private client: Arweave;

  public constructor(
    private arweaveJWT: JWKInterface,
    private logger: winston.Logger,
    gatewayURL = "arweave.net",
    protocol = "https",
    port = 443
  ) {
    this.client = new Arweave({
      host: gatewayURL,
      port,
      protocol,
      timeout: 20000,
      logging: false,
    });
    this.logger.info("Arweave client initialized");
  }

  /**
   * Stores an arbitrary record in the Arweave network. The record is stored as a JSON string and uses
   * JSON.stringify to convert the record to a string. The record has all of its big numbers converted
   * to strings for convenience.
   * @param value The value to store
   * @returns The transaction ID of the stored value
   * @
   */
  async set(value: Record<string, unknown>): Promise<string | undefined> {
    const transaction = await this.client.createTransaction(
      { data: JSON.stringify(value, jsonReplacerWithBigNumbers) },
      this.arweaveJWT
    );
    // Add tags to the transaction
    transaction.addTag("Content-Type", "application/json");
    // Sign the transaction
    await this.client.transactions.sign(transaction, this.arweaveJWT);
    // Send the transaction
    const result = await this.client.transactions.post(transaction);
    this.logger.debug({
      at: "ArweaveClient:set",
      message: `Arweave transaction posted with ${transaction.id}`,
    });
    // Ensure that the result is successful
    if (result.status !== 200) {
      this.logger.error({
        at: "ArweaveClient:set",
        message: `Arweave transaction failed with ${transaction.id}`,
        result,
        address: await this.getAddress(),
        balance: (await this.getBalance()).toString(),
      });
      throw new Error("Server failed to receive arweave transaction");
    }
    return transaction.id;
  }

  /**
   * Retrieves a record from the Arweave network. The record is expected to be a JSON string and is
   * parsed using JSON.parse. All numeric strings are converted to big numbers for convenience.
   * @param transactionID The transaction ID of the record to retrieve
   * @param structValidator An optional struct validator to validate the retrieved value. If the value does not match the struct, null is returned.
   * @returns The record if it exists, otherwise null
   */
  async get<T>(transactionID: string, validator?: Struct<T>): Promise<T | null> {
    const rawData = await this.client.transactions.getData(transactionID, { decode: true, string: true });
    if (!rawData) {
      return null;
    }
    // Parse the retrieved data - if it is an Uint8Array, it is a buffer and needs to be converted to a string
    const data = JSON.parse(typeof rawData === "string" ? rawData : Buffer.from(rawData).toString("utf-8"));
    // Ensure that the result is successful. If it is not, the retrieved value is not our expected type
    // but rather a {status: string, statusText: string} object. We can detect that and return null.
    if (data.status === 400) {
      return null;
    }
    if (validator && !is(data, validator)) {
      this.logger.warn("Retrieved value from Arweave does not match the expected type");
      return null;
    }
    return data as T;
  }

  /**
   * Returns the address of the signer of the JWT
   * @returns The address of the signer in this client
   */
  getAddress(): Promise<string> {
    return this.client.wallets.jwkToAddress(this.arweaveJWT);
  }

  /**
   * The balance of the signer
   * @returns The balance of the signer in winston units
   */
  async getBalance(): Promise<ethers.BigNumber> {
    const address = await this.getAddress();
    const balanceInFloat = await this.client.wallets.getBalance(address);
    return parseWinston(balanceInFloat);
  }
}