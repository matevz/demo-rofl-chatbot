import { FC, PropsWithChildren, useCallback, useEffect, useState } from 'react'
import { CHAINS, VITE_NETWORK } from '../constants/config'
import { handleKnownErrors, handleKnownEthersErrors, UnknownNetworkError } from '../utils/errors'
import { Web3Context, Web3ProviderContext, Web3ProviderState } from './Web3Context'
import { useEIP1193 } from '../hooks/useEIP1193'
import {
  BrowserProvider,
  Contract,
  EthersError,
  JsonRpcProvider,
  Signature
} from 'ethers'
import { SiweMessage } from 'siwe'
import { wrapEthersSigner, NETWORKS } from '@oasisprotocol/sapphire-ethers-v6'
import * as ChatBotAbi from '../../../contracts/out/ChatBot.sol/ChatBot.json'
import {Answer, PromptsAnswers} from "../types";

const { VITE_MESSAGE_BOX_ADDR } = import.meta.env

let EVENT_LISTENERS_INITIALIZED = false

const web3ProviderInitialState: Web3ProviderState = {
  isConnected: false,
  browserProvider: null,
  account: null,
  explorerBaseUrl: null,
  chainName: null,
  chainId: null,
  nativeCurrency: null,
  isInteractingWithChain: false,
  isWaitingChatBot: false,
  provider: new JsonRpcProvider(import.meta.env.VITE_WEB3_GATEWAY, undefined, {
    staticNetwork: true,
  }),
  isSapphire: null,
  authInfo: null,
}

export const Web3ContextProvider: FC<PropsWithChildren> = ({ children }) => {
  const {
    isEIP1193ProviderAvailable,
    connectWallet: connectWalletEIP1193,
    switchNetwork: switchNetworkEIP1193,
  } = useEIP1193()

  const [state, setState] = useState<Web3ProviderState>({
    ...web3ProviderInitialState,
  })

  useEffect(() => {
    setState(prevState => ({ ...prevState, isInteractingWithChain: false }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.account])

  const interactingWithChainWrapper = useCallback(
    <Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) =>
      async (...args: Args): Promise<R> => {
        setState(prevState => ({ ...prevState, isInteractingWithChain: true }))
        try {
          return await fn(...args)
        } catch (e) {
          handleKnownEthersErrors(e as EthersError)
          handleKnownErrors(e as Error)
          throw e
        } finally {
          setState(prevState => ({ ...prevState, isInteractingWithChain: false }))
        }
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const _connectionChanged = (isConnected: boolean) => {
    setState(prevState => ({
      ...prevState,
      isConnected,
    }))
  }

  const _accountsChanged = useCallback((accounts: string[]) => {
    if (accounts.length <= 0) {
      _connectionChanged(false)
      return
    }

    const [account] = accounts
    setState(prevState => ({
      ...prevState,
      account,
    }))
  }, [])

  const _setNetworkSpecificVars = (chainId: bigint, browserProvider = state.browserProvider!): void => {
    if (!browserProvider) {
      throw new Error('[Web3Context] Browser provider is required!')
    }

    if (!CHAINS.has(chainId)) {
      throw new UnknownNetworkError('Unknown network!')
    }

    const { blockExplorerUrls, chainName, nativeCurrency } = CHAINS.get(chainId)!
    const [explorerBaseUrl] = blockExplorerUrls

    setState(prevState => ({
      ...prevState,
      explorerBaseUrl,
      chainName,
      nativeCurrency,
    }))
  }

  const _chainChanged = useCallback((chainId: number) => {
    // Dirty workaround to access state
    setState(prevState => {
      if (prevState.isConnected && prevState.chainId !== BigInt(chainId)) {
        window.location.reload()
      }

      return prevState
    })
  }, [])

  const _connect = useCallback(() => _connectionChanged(true), [])
  const _disconnect = useCallback(() => _connectionChanged(false), [])

  const _addEventListenersOnce = useCallback(
    (ethProvider: typeof window.ethereum) => {
      if (EVENT_LISTENERS_INITIALIZED) {
        return
      }

      ethProvider?.on?.('accountsChanged', _accountsChanged)
      ethProvider?.on?.('chainChanged', _chainChanged)
      ethProvider?.on?.('connect', _connect)
      ethProvider?.on?.('disconnect', _disconnect)

      EVENT_LISTENERS_INITIALIZED = true
    },
    [_accountsChanged, _chainChanged, _connect, _disconnect]
  )

  const _init = async (account: string, provider: typeof window.ethereum) => {
    try {
      const browserProvider = new BrowserProvider(provider!)

      const network = await browserProvider.getNetwork()
      const chainId = network.chainId
      _setNetworkSpecificVars(chainId, browserProvider)

      setState(prevState => ({
        ...prevState,
        isConnected: true,
        browserProvider,
        account,
        chainId,
        isSapphire: !!NETWORKS[Number(chainId)],
      }))

      _addEventListenersOnce(window.ethereum)
    } catch (ex) {
      setState(prevState => ({
        ...prevState,
        isConnected: false,
      }))

      if (ex instanceof UnknownNetworkError) {
        throw ex
      } else {
        throw new Error('[Web3Context] Unable to initialize providers!')
      }
    }
  }

  const isProviderAvailable = async () => {
    return isEIP1193ProviderAvailable()
  }

  const connectWallet = async () => {
    const account = await connectWalletEIP1193()

    if (!account) {
      throw new Error('[Web3Context] Request account failed!')
    }

    await _init(account, window.ethereum)
  }

  const switchNetwork = async (chainId = VITE_NETWORK) => {
    return await switchNetworkEIP1193(chainId)
  }

  const getTransaction = async (txHash: string) => {
    if (!txHash) {
      throw new Error('[txHash] is required!')
    }

    const { browserProvider } = state

    if (!browserProvider) {
      throw new Error('[browserProvider] not initialized!')
    }

    const txReceipt = await browserProvider.waitForTransaction(txHash)
    if (txReceipt?.status === 0) throw new Error('Transaction failed')

    return await browserProvider.getTransaction(txHash)
  }

  const getGasPrice = async () => {
    const { browserProvider } = state

    if (!browserProvider) {
      return 0n
    }

    return (await browserProvider.getFeeData()).gasPrice ?? 0n
  }

  const _getWrappedSigner = async () => {
    const { isSapphire, browserProvider } = state

    if (isSapphire) {
      const signer = await browserProvider!.getSigner()
      return wrapEthersSigner(signer)
    }

    return await browserProvider!.getSigner()
  }

  const _getUnwrappedSigner = async () => {
    const { browserProvider } = state

    return await browserProvider!.getSigner()
  }

  const _getAuthInfo = async (chatBot: Contract): Promise<string> => {
    const { authInfo, chainId } = state

    const unwrappedSigner = await _getUnwrappedSigner()

    if (!authInfo) {
      const domain = await chatBot.domain()
      const siweMessage = new SiweMessage({
        domain,
        address: await unwrappedSigner.getAddress(),
        uri: `http://${domain}`,
        version: '1',
        chainId: Number(chainId),
      }).toMessage()
      const signature = Signature.from(await unwrappedSigner.signMessage(siweMessage))
      const retrievedAuthInfo = await chatBot.login(siweMessage, signature)

      setState(prevState => ({
        ...prevState,
        authInfo: retrievedAuthInfo,
      }))

      return retrievedAuthInfo
    }

    return authInfo
  }

  const getChatBot = async (): Promise<Contract> => {
    const wrappedSigner = await _getWrappedSigner()
    const abi = ChatBotAbi.abi
    return new Contract(VITE_MESSAGE_BOX_ADDR, abi, wrappedSigner)
  }

  const getPromptsAnswers = async (): Promise<PromptsAnswers> => {
    const chatBot = await getChatBot()
    const authInfo = await _getAuthInfo(chatBot)
    const [prompts, answersRaw] = await Promise.all([chatBot.getPrompts(authInfo, state.account), chatBot.getAnswers(authInfo, state.account)])
    let answers: Answer[] = []

    // Align prompts with (potentially empty) answers.
    for (let i=0, j=0; i<prompts.length; i++) {
      let answer = ''
      if (j<answersRaw.length && answersRaw[j].promptId==i) {
        answer = answersRaw[j].answer.substring(answersRaw[j].answer.indexOf("</think>") + 8) // trim off <think>...</think>,
        j++
      }
      answers.push({
        answer,
        promptId: i
      });
    }
    return { prompts, answers, htmlContent: '' }
  }

  const appendPrompt = async (message: string): Promise<void> => {
    const chatBot = await getChatBot()
    const { hash } = await chatBot.appendPrompt(message)
    const filter = chatBot.filters.AnswerSubmitted(state.account)
    chatBot.on(filter, async (sender: string) => {
      console.log("AnswerSubmitted sender: " + sender)
      setState(prevState => ({ ...prevState, isWaitingChatBot: false }))
    })
    setState(prevState => ({ ...prevState, isWaitingChatBot: true }))
    await getTransaction(hash)
    setState(prevState => ({ ...prevState, isInteractingWithChain: false }))
  }

  const clearPrompt = async (): Promise<void> => {
    const chatBot = await getChatBot()
    const { hash } = await chatBot.clearPrompt({ gasLimit: 1000000 })
    await getTransaction(hash)
  }

  const providerState: Web3ProviderContext = {
    state,
    isProviderAvailable,
    connectWallet,
    switchNetwork,
    getTransaction,
    getGasPrice,
    getPromptsAnswers,
    ask: interactingWithChainWrapper(appendPrompt),
    clear: interactingWithChainWrapper(clearPrompt),
  }

  return <Web3Context.Provider value={providerState}>{children}</Web3Context.Provider>
}
