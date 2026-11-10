import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'
import Approval from '../app/approval/[id]'

const mockGw = { approvals: jest.fn(), status: jest.fn(), decision: jest.fn(), approve: jest.fn(), reject: jest.fn() }
const mockFace = jest.fn()

jest.mock('expo-router', () => ({ router: { back: jest.fn() }, useLocalSearchParams: () => ({ id: 'dec_1' }), useFocusEffect: (fn: () => void) => { require('react').useEffect(fn, []) } }))
jest.mock('../src/state/session', () => ({ useGateway: () => mockGw, confirmWithFace: (...a: unknown[]) => mockFace(...a) }))

const decision = { decisionId: 'dec_1', mandateId: 'm1', agentId: 'spend-agent', host: '127.0.0.1', purpose: 'cost brief', amount: '0.202021', currency: 'USDC', depositAddress: '1ff307aeaaaaaaaaaaaad16369', decision: 'NEEDS_APPROVAL', state: 'pending', createdAt: '2026-11-09T09:00:00Z',
  checks: [{ id: 'C01', name: 'Mandate', result: 'pass' }, { id: 'C02', name: 'Scope', result: 'pass' }] }
const pending = { decisionId: 'dec_1', status: 'pending', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), decision }

const hold = async (ms: number) => { await fireEvent(screen.getByLabelText('Hold to approve'), 'pressIn'); await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }

beforeEach(() => { jest.clearAllMocks(); mockGw.approvals.mockResolvedValue([pending]); mockGw.status.mockResolvedValue({ frozen: false }) })

describe('Approve screen', () => {
  it('shows who wants to pay, how much, and how many checks passed', async () => {
    await render(<Approval />)
    expect(await screen.findByText('spend-agent wants to pay')).toBeTruthy()
    expect(screen.getByText('2 of 2 checks passed')).toBeTruthy()
    expect(screen.getByText('cost brief')).toBeTruthy()
  })

  it('letting go before the hold is complete does nothing: no Face ID, nothing approved', async () => {
    await render(<Approval />)
    await screen.findByText('spend-agent wants to pay')
    await hold(300)
    await fireEvent(screen.getByLabelText('Hold to approve'), 'pressOut')
    await act(async () => { await new Promise(r => setTimeout(r, 1500)) })
    expect(mockFace).not.toHaveBeenCalled()
    expect(mockGw.approve).not.toHaveBeenCalled()
  })

  it('a full hold asks for Face ID; a refused face means nothing is approved', async () => {
    mockFace.mockResolvedValue({ ok: false, why: 'Face not recognised.' })
    await render(<Approval />)
    await screen.findByText('spend-agent wants to pay')
    await hold(1400)
    expect(await screen.findByText('Face not recognised.')).toBeTruthy()
    expect(mockGw.approve).not.toHaveBeenCalled()
  })

  it('a full hold and Face ID call the gateway, and only its yes says Approved', async () => {
    mockFace.mockResolvedValue({ ok: true })
    mockGw.approve.mockResolvedValue({})
    await render(<Approval />)
    await screen.findByText('spend-agent wants to pay')
    await hold(1400)
    await waitFor(() => expect(mockGw.approve).toHaveBeenCalledWith('dec_1', expect.any(String)))
    expect(await screen.findByText(/Approved\./)).toBeTruthy()
  })

  it('if the gateway refuses, the screen says why and does not claim an approval', async () => {
    mockFace.mockResolvedValue({ ok: true })
    const { GatewayError } = require('../src/api/gateway')
    mockGw.approve.mockRejectedValue(new GatewayError('This payment already expired.', 409))
    await render(<Approval />)
    await screen.findByText('spend-agent wants to pay')
    await hold(1400)
    expect(await screen.findByText('This payment already expired.')).toBeTruthy()
    expect(screen.queryByText(/Approved\./)).toBeNull()
  })

  it('reject asks first, and rejects only after the owner confirms', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    mockGw.reject.mockResolvedValue({})
    await render(<Approval />)
    await screen.findByText('spend-agent wants to pay')
    await fireEvent.press(screen.getByText('Reject'))
    expect(mockGw.reject).not.toHaveBeenCalled()
    const buttons = alert.mock.calls[0]![2]!
    await act(async () => { await buttons.find(b => b.text === 'Reject')!.onPress!() })
    expect(mockGw.reject).toHaveBeenCalledWith('dec_1', expect.any(String))
    expect(await screen.findByText('Rejected. Nothing was paid.')).toBeTruthy()
  })

  it('while payments are frozen there is nothing to hold: the button is disabled and says why', async () => {
    mockGw.status.mockResolvedValue({ frozen: true })
    await render(<Approval />)
    expect(await screen.findByText('Payments are frozen. Unfreeze to approve.')).toBeTruthy()
    await hold(1400)
    expect(mockFace).not.toHaveBeenCalled()
  })
})
