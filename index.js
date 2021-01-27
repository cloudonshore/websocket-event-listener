import * as ethers from 'ethers'
import _ from 'lodash'

import { web3Provider } from '../constants'

const { Interface } = ethers.utils

const { hexlify, hexStripZeros } = ethers.utils

function parseEventLog(log, abiInterface) {
  let parsedLog
  try {
    parsedLog = abiInterface.parseLog(log)
  } catch (e) {
    // this was added because ERC721 transactions show up under the Transfer topic but can't be parsed by the human-standard-token abi
    return null
  }

  if (!parsedLog) {
    return null
  }

  const parsedLogValues = _.mapValues(parsedLog.values, v => {
    let stringVal = (v.toString ? v.toString() : v) || ''
    stringVal = _.startsWith(stringVal, '0x') ? stringVal.toLowerCase() : stringVal
    return stringVal
  }) // converts bignumbers to strings and lowercases everything (most importantly addresses)
  const argumentRange = _.range(Number(parsedLogValues.length)).map(p => p.toString())
  const formattedLogValues = _.pickBy(
    parsedLogValues,
    (param, key) => !_.includes(argumentRange, key) && key !== 'length', // removes some extra junk ethers puts in the parsed logs
  )
  const { address, topics, data, blockNumber, transactionHash, removed, transactionIndex, logIndex } = log
  const { name, signature, topic } = parsedLog
  return {
    ...{
      address: address.toLowerCase(),
      topics,
      data,
      blockNumber: ethers.BigNumber.from(blockNumber).toNumber(),
      transactionIndex: ethers.BigNumber.from(transactionIndex).toNumber(),
      logIndex: ethers.BigNumber.from(logIndex).toNumber(),
      transactionHash,
      removed,
    },
    ...{ name, signature, topic },
    values: formattedLogValues,
  }
}

const abiInterfaces = {}

function parseEventLogs(logs, abi) {
  if (logs.length === 0) {
    return logs
  }

  const [firstLog] = logs

  let abiInterface
  if (abiInterfaces[firstLog.address]) {
    abiInterface = abiInterfaces[firstLog.address]
  } else {
    abiInterface = new ethers.utils.Interface(abi)
    abiInterfaces[firstLog.address] = abiInterface
  }

  return _.compact(logs.map(log => parseEventLog(log, abiInterface)))
}

function fetchLatestBlock(includeFullTransactions = true) {
  // const method = {
  //   method: 'eth_getBlockByNumber',
  //   params: ['latest', includeFullTransactions], // [hex block number, include full transactions boolean]
  // }
  return web3Provider.eth.getBlock('latest', includeFullTransactions) // send(method).then(parseBlock)
}

function getLogs([params]) {
  return web3Provider.eth.getPastLogs(params) // send(method)
}

function getProviderLogs(params, provider) {
  const method = {
    method: 'eth_getLogs',
    params,
  }
  return provider.send(method)
}

async function fetchLogs(contractAddress, abi, topic, fromBlock, toBlock, parser, provider) {
  const query = {
    address: contractAddress || undefined,
    topics: _.isArray(topic) ? topic : [topic],
  }

  let logs
  const logParams = [
    {
      ...query,
      fromBlock: fromBlock ? hexStripZeros(hexlify(fromBlock)) : 'latest',
      toBlock: toBlock ? hexStripZeros(hexlify(toBlock)) : 'latest',
    },
  ]

  try {
    logs = await (provider ? getProviderLogs(logParams, provider) : getLogs(logParams))
  } catch (e) {
    console.log(`logs not ready for block ${toBlock}, retrying in 1s`, e, logParams)
    return new Promise((resolve, reject) => {
      setTimeout(
        () =>
          fetchLogs(contractAddress, abi, topic, fromBlock, toBlock, parser)
            .then(resolve)
            .catch(reject),
        1000,
      )
    })
  }
  const parsedEventLogs = parseEventLogs(logs, abi)
  return parser ? parser(parsedEventLogs) : parsedEventLogs
}

async function subscribe(contractAddress, abi, topic, fromBlock, callback, parser) {
  const query = {
    address: contractAddress || undefined,
    topics: topic,
  }
  const logParams = _.pickBy(
    {
      ...query,
      fromBlock,
    },
    _.identity,
  )

  const abiInterface = new Interface(abi)
  const subscription = web3Provider.eth.subscribe('logs', logParams, (error, log) => {
    if (error) {
      console.log(error)
    }
    if (parser) {
      callback(parser(parseEventLog(log, abiInterface)))
    } else {
      const parsedEventLog = parseEventLog(log, abiInterface)
      callback([parsedEventLog])
    }
  })

  return subscription
}

class EventTracker {
  constructor() {
    this.trackedEvents = []
  }

  async trackEvent(event) {
    const latestBlock = await fetchLatestBlock()
    const latestBlockNumber = latestBlock.number - 1
    this.subscribeToEvent(event, latestBlockNumber)
    this.trackedEvents.push(event)
    return true
  }
  // eslint-disable-next-line
  fetchHistoricalLogs(
    event,
    contractAddress,
    abi,
    topics,
    fromBlock,
    toBlock,
    callback,
    onFetchingHistoricalEvents = _.identity,
    onFetchedHistoricalEvents = _.identity,
    parser,
  ) {
    onFetchingHistoricalEvents()
    fetchLogs(contractAddress, abi, topics, fromBlock, toBlock, parser).then(events => {
      onFetchedHistoricalEvents(events)
      callback(events)
    })
  }

  subscribeToEvent(event, blockNumber) {
    //eslint-disable-line
    const {
      contract,
      abi,
      callback,
      parser,
      backFillBlockCount,
      fromBlock,
      onFetchingHistoricalEvents,
      onFetchedHistoricalEvents,
    } = event
    let fromBlockNumberOverride

    if (!_.isUndefined(fromBlock)) {
      fromBlockNumberOverride = Number(fromBlock)
    } else if (!_.isUndefined(backFillBlockCount)) {
      fromBlockNumberOverride = blockNumber - Number(backFillBlockCount)
    }

    const topics = this.getEventTopics(event)

    if (fromBlockNumberOverride) {
      this.fetchHistoricalLogs(
        event,
        contract,
        abi,
        topics,
        fromBlockNumberOverride,
        blockNumber,
        callback,
        onFetchingHistoricalEvents,
        onFetchedHistoricalEvents,
        parser,
      )
    }

    subscribe(contract, abi, topics, blockNumber, callback, parser)
  }
  // eslint-disable-next-line
  getEventTopics({ name, params: paramsInputs, abi }) {
    const params = _.pickBy(paramsInputs || {}, _.identity) // default to empty object if undefined
    const abiInterface = new ethers.utils.Interface(abi)
    const { events } = abiInterface
    const mappedEvents = _.mapKeys(events, (val, key) => _.first(key.split('(')))
    const abiEvent = mappedEvents[name]

    if (!abiEvent) {
      throw new Error(
        `${name} not an abi event, possible events are ${_.uniq(_.map(_.values(events), 'name')).join(', ')}`,
      )
    }

    const paramsArray = abiEvent.inputs.map(({ name: inputName }) =>
      _.isUndefined(params[inputName]) ? null : params[inputName],
    )
    return abiInterface.encodeFilterTopics(name, paramsArray)
  }
}

export default EventTracker
