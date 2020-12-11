const path = require('path')
const chalk = require('chalk')
const { assert } = require('chai')
const { getEvents } = require('@aragon/contract-helpers-test')
const { hash: namehash } = require('eth-ens-namehash')
const { toChecksumAddress } = require('web3-utils')

const runOrWrapScript = require('../helpers/run-or-wrap-script')
const { log } = require('../helpers/log')
const { readNetworkState, persistNetworkState, assertRequiredNetworkState } = require('../helpers/persisted-network-state')
const { saveCallTxData } = require('../helpers/tx-data')
const { resolveLatestVersion: apmResolveLatest } = require('../components/apm')

const { APP_NAMES } = require('./constants')
const VALID_APP_NAMES = Object.entries(APP_NAMES).map((e) => e[1])

const REQUIRED_NET_STATE = [
  'ensAddress',
  'multisigAddress',
  'daoTemplateAddress',
  'createAppReposTx',
  `app:${APP_NAMES.LIDO}`,
  `app:${APP_NAMES.ORACLE}`,
  `app:${APP_NAMES.NODE_OPERATORS_REGISTRY}`,
  'daoInitialSettings'
]

const NETWORK_STATE_FILE = process.env.NETWORK_STATE_FILE || 'deployed.json'
const ARAGON_APM_ENS_DOMAIN = 'aragonpm.eth'

async function deployDAO({ web3, artifacts, networkStateFile = NETWORK_STATE_FILE }) {
  const netId = await web3.eth.net.getId()

  log.splitter()
  log(`Network ID: ${chalk.yellow(netId)}`)

  const state = readNetworkState(networkStateFile, netId)
  assertRequiredNetworkState(state, REQUIRED_NET_STATE)

  log.splitter()
  log(`Using LidoTemplate: ${chalk.yellow(state.daoTemplateAddress)}`)
  log(`Using createRepos transaction: ${chalk.yellow(state.createAppReposTx)}`)

  log.splitter(`Checking preconditions...`)
  await checkAppRepos(state)

  log.splitter()

  const template = await artifacts.require('LidoTemplate3').at(state.daoTemplateAddress)
  const { daoInitialSettings } = state

  const votingSettings = [
    daoInitialSettings.votingSettings.minSupportRequired,
    daoInitialSettings.votingSettings.minAcceptanceQuorum,
    daoInitialSettings.votingSettings.voteDuration
  ]

  const beaconSpec = [
    daoInitialSettings.beaconSpec.epochsPerFrame,
    daoInitialSettings.beaconSpec.slotsPerEpoch,
    daoInitialSettings.beaconSpec.secondsPerSlot,
    daoInitialSettings.beaconSpec.genesisTime
  ]

  log(`Using DAO settings:`, daoInitialSettings)

  await saveCallTxData(`newDAO`, template, 'newDAO', `tx-07-deploy-dao.json`, {
    arguments: [
      daoInitialSettings.tokenName,
      daoInitialSettings.tokenSymbol,
      votingSettings,
      daoInitialSettings.beaconSpec.depositContractAddress,
      beaconSpec
    ],
    from: state.multisigAddress
  })
}

async function checkAppRepos(state) {
  const receipt = await web3.eth.getTransactionReceipt(state.createAppReposTx)
  if (!receipt) {
    assert(false, `transaction ${state.createAppReposTx} not found`)
  }

  const { abi: APMRegistryABI } = await artifacts.readArtifact('APMRegistry')
  const events = getEvents(receipt, 'NewRepo', { decodeForAbi: APMRegistryABI })

  const repoIds = events.map((evt) => evt.args.id)
  const expectedIds = VALID_APP_NAMES.map((name) => namehash(`${name}.${state.lidoApmEnsName}`))

  const idsCheckDesc = `all (and only) expected app repos are created`
  assert.sameMembers(repoIds, expectedIds, idsCheckDesc)
  log.success(idsCheckDesc)

  const Repo = artifacts.require('Repo')

  const appsInfo = await Promise.all(
    events.map(async (evt) => {
      const repo = await Repo.at(evt.args.repo)
      const latest = await repo.getLatest()
      return {
        appName: evt.args.name,
        contractAddress: latest.contractAddress,
        contentURI: latest.contentURI
      }
    })
  )

  const aragonApps = appsInfo.filter((info) => info.appName.startsWith('aragon-'))
  const lidoApps = appsInfo.filter((info) => !info.appName.startsWith('aragon-'))

  for (const app of lidoApps) {
    const appState = state[`app:${app.appName}`]
    const appDesc = `repo ${chalk.yellow(app.appName + '.' + state.lidoApmEnsName)}`

    const addrCheckDesc = `${appDesc}: latest version contract address is correct`
    assert.equal(app.contractAddress, appState.baseAddress, addrCheckDesc)
    log.success(addrCheckDesc)

    const contentCheckDesc = `${appDesc}: latest version content URI is correct`
    assert.equal(app.contentURI, appState.contentURI, contentCheckDesc)
    log.success(contentCheckDesc)
  }

  const ens = await artifacts.require('ENS').at(state.ensAddress)

  for (const app of aragonApps) {
    const upstreamRepoName = `${app.appName.substring(7)}.${ARAGON_APM_ENS_DOMAIN}`
    const latestAragonVersion = await apmResolveLatest(namehash(upstreamRepoName), ens, artifacts)

    const appDesc = `repo ${chalk.yellow(app.appName + '.' + state.lidoApmEnsName)}`

    const addrCheckDesc = `${appDesc}: latest version contract address is the same as in repo ${chalk.yellow(upstreamRepoName)}`
    assert.equal(app.contractAddress, latestAragonVersion.contractAddress, addrCheckDesc)
    log.success(addrCheckDesc)

    const contentCheckDesc = `${appDesc}: latest version content URI is the same as in repo ${chalk.yellow(upstreamRepoName)}`
    assert.equal(app.contentURI, latestAragonVersion.contentURI, contentCheckDesc)
    log.success(contentCheckDesc)
  }
}

module.exports = runOrWrapScript(deployDAO, module)