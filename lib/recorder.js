"use strict";
// Records gas, calldata, log and storage footprint of every transaction (Hardhat network).
// Storage growth is measured from debug_traceTransaction: under London gas rules an SSTORE that
// turns a zero slot into a non-zero value costs 20,000 gas (+2,100 if the slot is cold), so such
// operations identify newly allocated 32-byte storage slots.

class Recorder {
  constructor(provider, { traceStorage = false } = {}) {
    this.provider = provider;
    this.traceStorage = traceStorage;
    this.entries = [];
    this.deployments = [];
  }

  async storageWrites(hash) {
    if (!this.traceStorage) return { newSlots: null, updatedSlots: null };
    const trace = await this.provider.send("debug_traceTransaction", [hash, { disableMemory: true, disableStack: true, disableStorage: true }]);
    let newSlots = 0;
    let updatedSlots = 0;
    for (const log of trace.structLogs) {
      if (log.op !== "SSTORE") continue;
      if (log.gasCost >= 20000) newSlots += 1;
      else if (log.gasCost >= 2900) updatedSlots += 1;
    }
    return { newSlots, updatedSlots };
  }

  static logBytes(receipt) {
    return receipt.logs.reduce((n, l) => n + l.topics.length * 32 + (l.data.length - 2) / 2, 0);
  }

  async deployment(name, contract) {
    const tx = contract.deploymentTransaction();
    const receipt = await tx.wait();
    const code = await this.provider.getCode(await contract.getAddress());
    this.deployments.push({ name, gasUsed: Number(receipt.gasUsed), runtimeBytes: (code.length - 2) / 2, initcodeBytes: (tx.data.length - 2) / 2 });
  }

  /** Sends a transaction (promise of a TransactionResponse) and records its footprint. */
  async send(label, act, txPromise, meta = {}) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const block = await this.provider.getBlock(receipt.blockNumber);
    const storage = await this.storageWrites(receipt.hash);
    this.entries.push({
      label,
      act,
      gasUsed: Number(receipt.gasUsed),
      calldataBytes: (tx.data.length - 2) / 2,
      logBytes: Recorder.logBytes(receipt),
      logCount: receipt.logs.length,
      ...storage,
      block: receipt.blockNumber,
      timestamp: block.timestamp,
      hash: receipt.hash,
      ...meta,
    });
    return receipt;
  }

  /** Aggregates entries by label: count, min, mean, max gas and mean footprint. */
  summary(filter = () => true) {
    const groups = new Map();
    for (const e of this.entries.filter(filter)) {
      if (!groups.has(e.label)) groups.set(e.label, []);
      groups.get(e.label).push(e);
    }
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return [...groups.entries()].map(([label, es]) => ({
      label,
      count: es.length,
      gasMin: Math.min(...es.map((e) => e.gasUsed)),
      gasMean: Math.round(mean(es.map((e) => e.gasUsed))),
      gasMax: Math.max(...es.map((e) => e.gasUsed)),
      calldataBytesMean: Math.round(mean(es.map((e) => e.calldataBytes))),
      logBytesMean: Math.round(mean(es.map((e) => e.logBytes))),
      newSlotsMean: es[0].newSlots === null ? null : +mean(es.map((e) => e.newSlots)).toFixed(1),
      totalGas: es.reduce((a, e) => a + e.gasUsed, 0),
    }));
  }

  totals(filter = () => true) {
    const es = this.entries.filter(filter);
    return {
      transactions: es.length,
      gasUsed: es.reduce((a, e) => a + e.gasUsed, 0),
      calldataBytes: es.reduce((a, e) => a + e.calldataBytes, 0),
      logBytes: es.reduce((a, e) => a + e.logBytes, 0),
      newSlots: es[0] && es[0].newSlots !== null ? es.reduce((a, e) => a + e.newSlots, 0) : null,
    };
  }
}

module.exports = { Recorder };
