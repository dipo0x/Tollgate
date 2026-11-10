import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import Freeze from '../app/freeze'

const mockGw = { status: jest.fn(), freeze: jest.fn(), unfreeze: jest.fn() }
const mockFace = jest.fn()

jest.mock('expo-router', () => ({ router: { back: jest.fn() }, useFocusEffect: (fn: () => void) => { require('react').useEffect(fn, []) } }))
jest.mock('../src/state/session', () => ({ useGateway: () => mockGw, confirmWithFace: (...a: unknown[]) => mockFace(...a) }))

beforeEach(() => { jest.clearAllMocks() })

describe('Kill switch screen', () => {
  it('freezing is one tap and asks for no Face ID', async () => {
    mockGw.status.mockResolvedValueOnce({ frozen: false }).mockResolvedValue({ frozen: true })
    mockGw.freeze.mockResolvedValue({})
    await render(<Freeze />)
    await fireEvent.press(await screen.findByLabelText('Freeze all payments'))
    await waitFor(() => expect(mockGw.freeze).toHaveBeenCalledTimes(1))
    expect(mockFace).not.toHaveBeenCalled()
    expect(await screen.findByText('Payments frozen')).toBeTruthy()
  })

  it('unfreezing needs Face ID first; a refused face leaves it frozen', async () => {
    mockGw.status.mockResolvedValue({ frozen: true })
    mockFace.mockResolvedValue({ ok: false, why: 'Face not recognised.' })
    await render(<Freeze />)
    await fireEvent.press(await screen.findByLabelText('Unfreeze with Face ID'))
    expect(await screen.findByText('Face not recognised.')).toBeTruthy()
    expect(mockGw.unfreeze).not.toHaveBeenCalled()
  })

  it('with Face ID, unfreezing calls the gateway', async () => {
    mockGw.status.mockResolvedValueOnce({ frozen: true }).mockResolvedValue({ frozen: false })
    mockFace.mockResolvedValue({ ok: true })
    mockGw.unfreeze.mockResolvedValue({})
    await render(<Freeze />)
    await fireEvent.press(await screen.findByLabelText('Unfreeze with Face ID'))
    await waitFor(() => expect(mockGw.unfreeze).toHaveBeenCalledTimes(1))
  })
})
