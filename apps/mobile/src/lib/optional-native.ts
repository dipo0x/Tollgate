import { requireOptionalNativeModule } from 'expo'
import type * as ImagePickerModule from 'expo-image-picker'
import type * as SpeechModule from 'expo-speech-recognition'

/**
 * Features that need native code the installed app may not have yet (an older build, the simulator, Expo Go). Checked once,
 * then loaded only when present: a missing feature hides its button instead of crashing the whole app.
 */
export const photos: typeof ImagePickerModule | null = requireOptionalNativeModule('ExponentImagePicker') ? require('expo-image-picker') : null
export const speech: typeof SpeechModule | null = requireOptionalNativeModule('ExpoSpeechRecognition') ? require('expo-speech-recognition') : null
