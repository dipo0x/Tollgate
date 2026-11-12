import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import AgentDetail from '../app/agents/[id]'

const mockGw = { pauseAgent: jest.fn(), resumeAgent: jest.fn(), stopAgent: jest.fn() }
const mockFace = jest.fn()
const mockLoad = jest.fn()

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() }, useLocalSearchParams: () => ({ id: 'mnd_buyer' }), useFocusEffect: (fn: () => void) => { require('react').useEffect(fn, []) } }))
jest.mock('../src/state/session', () => ({ useGateway: () => mockGw, useSession: () => ({ url: 'http://192.168.1.20:8787' }), confirmWithFace: (...a: unknown[]) => mockFace(...a) }))
jest.mock('../src/state/loaders', () => ({ loaders: { agent: () => mockLoad() } }))

const spec = {
  id: 'mnd_buyer', agentId: 'buyer', validUntil: '2026-12-01T00:00:00Z', budget: { currency: 'USDC', total: '1.00', perPayment: '0.25' },
  approval: { above: '0.00', riskAbove: 90, firstPayeeRequiresApproval: true }, allowedHosts: ['127.0.0.1'], allowedOriginNetworks: ['near'], allowedAssets: ['USDC'], refund: { mustBePayerOrPinned: true },
}
const loaded = (paused: boolean) => ({
  mandate: spec, status: 'active', balance: { total: '1.000000', remaining: '1.000000', settled: '0.000000', committed: '0.000000', released: '0.000000', proposed: '0.000000' }, decisions: [],
  row: { id: 'mnd_buyer', agentId: 'buyer', status: 'active', mode: 'hosted', brain: null, validUntil: spec.validUntil, currency: 'USDC', perPayment: '0.25', balance: null, ...(paused ? { paused: true } : {}) },
})

beforeEach(() => { jest.clearAllMocks() })

describe('Pause one agent', () => {
  it('pausing is one tap and asks for no Face ID', async () => {
    mockLoad.mockResolvedValueOnce(loaded(false)).mockResolvedValue(loaded(true))
    mockGw.pauseAgent.mockResolvedValue({})
    await render(<AgentDetail />)
    await fireEvent.press(await screen.findByText('Pause buyer'))
    await waitFor(() => expect(mockGw.pauseAgent).toHaveBeenCalledWith('buyer'))
    expect(mockFace).not.toHaveBeenCalled()
    expect(await screen.findByText('Resume buyer')).toBeTruthy()
  })

  it('resuming needs Face ID; a refused face leaves it paused', async () => {
    mockLoad.mockResolvedValue(loaded(true))
    mockFace.mockResolvedValue({ ok: false, why: 'Face not recognised.' })
    await render(<AgentDetail />)
    await fireEvent.press(await screen.findByText('Resume buyer'))
    expect(await screen.findByText('Face not recognised.')).toBeTruthy()
    expect(mockGw.resumeAgent).not.toHaveBeenCalled()
  })

  it('with Face ID, resuming calls the gateway', async () => {
    mockLoad.mockResolvedValue(loaded(true))
    mockFace.mockResolvedValue({ ok: true })
    mockGw.resumeAgent.mockResolvedValue({})
    await render(<AgentDetail />)
    await fireEvent.press(await screen.findByText('Resume buyer'))
    await waitFor(() => expect(mockGw.resumeAgent).toHaveBeenCalledWith('buyer'))
  })
})
