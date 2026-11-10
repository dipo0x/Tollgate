import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { GatewayError } from '../src/api/gateway'
import Withdraw from '../app/withdraw'

const mockGw = { withdrawals: jest.fn(), withdraw: jest.fn() }
const mockFace = jest.fn()

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() }, useFocusEffect: (fn: () => void) => { require('react').useEffect(fn, []) } }))
jest.mock('../src/state/session', () => ({ useGateway: () => mockGw, confirmWithFace: (...a: unknown[]) => mockFace(...a) }))

const info = { enabled: true, to: 'owner.near', balance: '0.635728', held: '0.000000', available: '0.635728', near: '0.0550', withdrawals: [] }

beforeEach(() => { jest.clearAllMocks(); mockGw.withdrawals.mockResolvedValue(info) })

describe('Withdraw screen', () => {
  it('shows what can leave, cut to cents, and where it goes', async () => {
    await render(<Withdraw />)
    expect(await screen.findByText('0.63 USDC')).toBeTruthy()
    expect(screen.getByText('owner.near')).toBeTruthy()
  })

  it('Max fills whole cents and the owner has to pass Face ID before anything is sent', async () => {
    mockFace.mockResolvedValue({ ok: false, why: 'Face not recognised.' })
    await render(<Withdraw />)
    await screen.findByText('0.63 USDC')
    await fireEvent.press(screen.getByLabelText('Withdraw everything available'))
    expect(screen.getByLabelText('Amount to withdraw in USDC').props.value).toBe('0.63')
    await fireEvent.press(screen.getByRole('button', { name: 'Withdraw' }))
    expect(await screen.findByText('Face not recognised.')).toBeTruthy()
    expect(mockGw.withdraw).not.toHaveBeenCalled()
  })

  it('after Face ID it sends the exact amount, and shows the result', async () => {
    mockFace.mockResolvedValue({ ok: true })
    mockGw.withdraw.mockResolvedValue({ withdrawalId: 'wd_1', amount: '0.630000', to: 'owner.near', txHash: 'H' })
    await render(<Withdraw />)
    await screen.findByText('0.63 USDC')
    await fireEvent.changeText(screen.getByLabelText('Amount to withdraw in USDC'), '0.63')
    await fireEvent.press(screen.getByRole('button', { name: 'Withdraw' }))
    await waitFor(() => expect(mockGw.withdraw).toHaveBeenCalledWith('0.630000'))
    expect(await screen.findByText('Sent 0.63 USDC')).toBeTruthy()
  })

  it('a refusal from the network is shown in words, and nothing is marked sent', async () => {
    mockFace.mockResolvedValue({ ok: true })
    mockGw.withdraw.mockRejectedValue(new GatewayError('NEAR refused the transaction before running it, so no USDC moved', 502))
    await render(<Withdraw />)
    await screen.findByText('0.63 USDC')
    await fireEvent.changeText(screen.getByLabelText('Amount to withdraw in USDC'), '0.5')
    await fireEvent.press(screen.getByRole('button', { name: 'Withdraw' }))
    expect(await screen.findByText(/no USDC moved/)).toBeTruthy()
    expect(screen.queryByText(/Sent/)).toBeNull()
  })

  it('refuses an amount above what can leave without calling the gateway', async () => {
    await render(<Withdraw />)
    await screen.findByText('0.63 USDC')
    await fireEvent.changeText(screen.getByLabelText('Amount to withdraw in USDC'), '5')
    expect(screen.getByText(/more than the 0.63 USDC/)).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Withdraw' }))
    expect(mockFace).not.toHaveBeenCalled()
  })

  it('says so, and offers no button, when withdrawals are off', async () => {
    mockGw.withdrawals.mockResolvedValue({ enabled: false, reason: 'Withdrawals are off on this gateway.', withdrawals: [] })
    await render(<Withdraw />)
    expect(await screen.findByText('Withdrawals are off on this gateway.')).toBeTruthy()
    expect(screen.queryByText('Withdraw everything available')).toBeNull()
  })
})
