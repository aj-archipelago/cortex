import {useState} from 'react';
import type {Voice, OpenAIVoice, AzureVoice} from '../../cortex-realtime-voice-server/src/realtime/realtimeTypes';
import {View, Text, TextInput, Pressable, StyleSheet} from "react-native";
import RNPickerSelect from 'react-native-picker-select';
import Checkbox from 'expo-checkbox';

type SettingsModalProps = {
  aiName: string;
  userName: string;
  userId: string;
  isOpen: boolean;
  onClose: () => void;
  onSave: (settings: SettingsData) => void;
}

export type SettingsData = {
  userName: string;
  userId: string;
  aiName: string;
  language: string;
  aiMemorySelfModify: boolean;
  aiStyle: string;
  voice: Voice;
}

const openaiVoices: OpenAIVoice[] = ['alloy', 'echo', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'];
const azureVoices: AzureVoice[] = ['amuch', 'dan', 'elan', 'marilyn', 'meadow', 'breeze', 'cove', 'ember', 'jupiter', 'alloy', 'echo', 'shimmer'];
const languages = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  ru: "Русский",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
}

// Check if we're using Azure based on the environment variable
const isAzure = process.env.REACT_APP_VOICE_PROVIDER === 'azure';

export const SettingsModal = (
  {aiName, userName, userId, isOpen, onClose, onSave}: SettingsModalProps
) => {
  const [newAiName, setAiName] = useState(aiName);
  const [newUserName, setUserName] = useState(userName);
  const [newUserId, setUserId] = useState(userId);
  const [language, setLanguage] = useState('English');
  const [aiMemorySelfModify, setAiMemorySelfModify] = useState(false);
  const [aiStyle, setAiStyle] = useState('Anthropic');
  const [voice, setVoice] = useState('alloy' as Voice);
  const voices = isAzure ? azureVoices : openaiVoices;

  const handleSubmit = () => {
    onSave({
      aiName: newAiName,
      userName: newUserName,
      userId: newUserId,
      language,
      aiMemorySelfModify,
      aiStyle,
      voice
    });
    onClose();
  };

  return (
    <View className={"flex"}>
      <View className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        <View
          className="inline-block w-full max-w-md p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-gray-800 border border-gray-700/50 rounded-2xl shadow-2xl sm:align-middle">
          <Text className="text-lg font-bold leading-6 text-gray-100 mb-4">
            System Configuration
          </Text>
          <View>
            <Text className="block text-sm font-bold text-gray-300 mb-1">
              Your Name
            </Text>
            <TextInput
              className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              value={newUserName}
              autoComplete="name"
              onChangeText={setUserName}
            />
          </View>

          <View className="my-2">
            <Text className="block text-sm font-bold text-gray-300 my-1">
              AI Name
            </Text>
            <TextInput
              className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              value={newAiName}
              onChangeText={setAiName}
            />
          </View>

          <View className="my-2">
            <Text className="block text-sm font-bold text-gray-300 my-1">
              Voice
            </Text>
            <RNPickerSelect
              value={voice}
              onValueChange={setVoice}
              style={pickerSelectStyles}
              items={voices.map((voice: Voice) => {
                return {label: voice.charAt(0).toUpperCase() + voice.slice(1), value: voice}
              })}/>
          </View>

          <View className="my-2">
            <Text className="block text-sm font-bold text-gray-300 mb-1">
              Language
            </Text>
            <RNPickerSelect
              value={language}
              onValueChange={setLanguage}
              style={pickerSelectStyles}
              items={Object.entries(languages).map(([code, name]) => {
                return {label: name, value: code}
              })}/>
          </View>

          <View className="my-2">
            <Text className="block text-sm font-bold text-gray-300 mb-1">
              AI Style
            </Text>
            <RNPickerSelect
              value={aiStyle}
              onValueChange={setAiStyle}
              style={pickerSelectStyles}
              items={[{label: 'Anthropic', value: 'Anthropic'}, {label: 'OpenAI', value: 'OpenAI'}]}
            />
          </View>

          <View className="my-2">
            <Text className="block text-sm font-bold text-gray-300 mb-1">
              Memory Key
            </Text>
            <TextInput
              className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              value={newUserId}
              onChangeText={setUserId}
            />
          </View>

          <View className="mt-2 flex-row">
            <Checkbox
              value={aiMemorySelfModify}
              onValueChange={setAiMemorySelfModify}
              className="w-4 h-4 border-gray-600 rounded bg-gray-700 text-cyan-500 focus:ring-cyan-500/50"
            />
            <Text className="ml-2 text-sm text-gray-300">
              Enable AI Memory Self-Modification
            </Text>
          </View>

          <View className="flex justify-end mt-6">
            <Pressable
              className="px-4 py-2 bg-black rounded-lg shadow-lg shadow-cyan-500/20"
              onPress={handleSubmit}>
              <Text className="text-white text-center">
                Save Configuration
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const pickerSelectStyles = StyleSheet.create({
  inputIOSContainer: { pointerEvents: "none" },
  inputIOS: {
    backgroundColor: 'rgba(55 65 81 / 0.5)',
    fontSize: 14,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: 'rgba(75 85 99 / 0.5)',
    borderRadius: 8,
    color: '#f3f4f6',
    paddingRight: 30, // to ensure the text is never behind the icon
  },
  inputAndroid: {
    backgroundColor: 'rgba(55 65 81 / 0.5)',
    fontSize: 14,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: 'rgba(75 85 99 / 0.5)',
    borderRadius: 8,
    color: '#f3f4f6',
    paddingRight: 30, // to ensure the text is never behind the icon
  },
});
