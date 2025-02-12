import {StatusBar} from 'expo-status-bar';
import {Text, View, ActivityIndicator, Pressable, Modal} from 'react-native';
import "./global.css";
import {useEffect, useState} from 'react';
import {SettingsModal} from "./SettingsModal";
import {SettingsData} from "./SettingsModal";
import AsyncStorage from '@react-native-async-storage/async-storage';
import Chat from "./chat/Chat";
import {SafeAreaView, SafeAreaProvider} from "react-native-safe-area-context";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  const [userId, setUserId] = useState('');
  const [aiName, setAiName] = useState('Jarvis');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [language, setLanguage] = useState('en');
  const [aiMemorySelfModify, setAiMemorySelfModify] = useState(false);
  const [aiStyle, setAiStyle] = useState('Anthropic');
  const [voice, setVoice] = useState('alloy');

  const onCloseSettings = () => setSettingsOpen(false);
  const onSaveSettings = async (settings: SettingsData) => {
    console.log('Saving settings', settings);
    setUserName(settings.userName);
    await AsyncStorage.setItem('userName', settings.userName);

    let newUserId = settings.userId;
    if (!newUserId || newUserId.length === 0) {
      newUserId = Math.random().toString(36).substring(7);
    }
    setUserId(newUserId);
    await AsyncStorage.setItem('userId', newUserId);

    setAiName(settings.aiName);
    await AsyncStorage.setItem('aiName', settings.aiName);

    setLanguage(settings.language);
    await AsyncStorage.setItem('language', settings.language);

    setAiMemorySelfModify(settings.aiMemorySelfModify);
    await AsyncStorage.setItem('aiMemorySelfModify', String(settings.aiMemorySelfModify));

    setAiStyle(settings.aiStyle);
    await AsyncStorage.setItem('aiStyle', settings.aiStyle);

    setVoice(settings.voice);
    await AsyncStorage.setItem('voice', settings.voice);
  };

  useEffect(() => {
    const loadSettings = async () => {
      const name = await AsyncStorage.getItem('userName');
      if (name) {
        setUserName(name);
      } else {
        setSettingsOpen(true);
      }
      const id = await AsyncStorage.getItem('userId');
      if (id) {
        setUserId(id);
      } else {
        setSettingsOpen(true);
      }
      const ai = await AsyncStorage.getItem('aiName');
      if (ai) {
        setAiName(ai);
      } else {
        setSettingsOpen(true);
      }
      const savedLanguage = await AsyncStorage.getItem('language');
      if (savedLanguage) setLanguage(savedLanguage);

      const savedAiMemorySelfModify = await AsyncStorage.getItem('aiMemorySelfModify');
      if (savedAiMemorySelfModify) setAiMemorySelfModify(savedAiMemorySelfModify === 'true');

      const savedAiStyle = await AsyncStorage.getItem('aiStyle');
      if (savedAiStyle) setAiStyle(savedAiStyle);

      const savedVoice = await AsyncStorage.getItem('voice');
      if (savedVoice) setVoice(savedVoice);

      setLoading(false);
    }
    loadSettings().then(() => console.log('Settings loaded'));
  }, []);

  if (loading) {
    return (
      <View className="bg-white dark:bg-slate-800 dark:text-white min-w-72 flex justify-center items-center">
        <ActivityIndicator color={'#0EA5E9'} size={150}/>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView className="flex bg-black dark:text-white min-w-72">
        <StatusBar style="light"/>
        <View className="h-9 mt-2">
          <Text className='text-xl font-bold text-center text-white'>AI Chat</Text>
        </View>
        <Pressable
          className="flex justify-end pr-2 -mt-10 w-full"
          onPress={() => {
            console.log('opening settings');
            setSettingsOpen(true)
          }}
          aria-label="Settings"
        >
          <Text className="text-xl p-1 text-right">
            ⚙️
          </Text>
        </Pressable>

        {userName && userName.length > 0 && (
          <Chat
            userId={userId}
            userName={userName}
            aiName={aiName}
            language={language}
            aiMemorySelfModify={aiMemorySelfModify}
            aiStyle={aiStyle}
            voice={voice}
          />
        )}
        <View>
          <Modal
            animationType="slide"
            transparent={true}
            visible={settingsOpen}
            onRequestClose={() => {
              setSettingsOpen(false);
            }}>
            <SettingsModal
              aiName={aiName}
              userName={userName}
              userId={userId}
              onClose={onCloseSettings}
              onSave={onSaveSettings}
            />
          </Modal>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
