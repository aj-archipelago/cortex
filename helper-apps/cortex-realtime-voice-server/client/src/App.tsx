import {useEffect, useState} from 'react';
import ClipLoader from "react-spinners/ClipLoader";
import Chat from "./chat/Chat";
import {SettingsModal} from "./SettingsModal";
import { SettingsData } from "./SettingsModal";

function App() {
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
  const onSaveSettings = (settings: SettingsData) => {
    console.log('Saving settings', settings);
    setUserName(settings.userName);
    localStorage.setItem('userName', settings.userName);

    let newUserId = settings.userId;
    if (!newUserId || newUserId.length === 0) {
      newUserId = Math.random().toString(36).substring(7);
    }
    setUserId(newUserId);
    localStorage.setItem('userId', newUserId);

    setAiName(settings.aiName);
    localStorage.setItem('aiName', settings.aiName);

    setLanguage(settings.language);
    localStorage.setItem('language', settings.language);

    setAiMemorySelfModify(settings.aiMemorySelfModify);
    localStorage.setItem('aiMemorySelfModify', String(settings.aiMemorySelfModify));

    setAiStyle(settings.aiStyle);
    localStorage.setItem('aiStyle', settings.aiStyle);

    setVoice(settings.voice);
    localStorage.setItem('voice', settings.voice);
  };

  useEffect(() => {
    const name = localStorage.getItem('userName');
    if (name) {
      setUserName(localStorage.getItem('userName') as string);
    } else {
      setSettingsOpen(true);
    }
    const id = localStorage.getItem('userId');
    if (id) {
      setUserId(localStorage.getItem('userId') as string);
    } else {
      setSettingsOpen(true);
    }
    const ai = localStorage.getItem('aiName');
    if (ai) {
      setAiName(localStorage.getItem('aiName') as string);
    } else {
      setSettingsOpen(true);
    }
    const savedLanguage = localStorage.getItem('language');
    if (savedLanguage) setLanguage(savedLanguage);

    const savedAiMemorySelfModify = localStorage.getItem('aiMemorySelfModify');
    if (savedAiMemorySelfModify) setAiMemorySelfModify(savedAiMemorySelfModify === 'true');

    const savedAiStyle = localStorage.getItem('aiStyle');
    if (savedAiStyle) setAiStyle(savedAiStyle);

    const savedVoice = localStorage.getItem('voice');
    if (savedVoice) setVoice(savedVoice);

    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900 flex justify-center items-center">
        <ClipLoader color={'#0EA5E9'} loading={true} size={150}/>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900">
      <button
        className="fixed top-4 right-4 z-10 p-2 text-gray-400 hover:text-cyan-400 transition-colors duration-200"
        onClick={() => setSettingsOpen(true)}
        aria-label="Settings"
      >
        ⚙️
      </button>

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
      <SettingsModal
        aiName={aiName}
        userName={userName}
        userId={userId}
        voice={voice}
        aiStyle={aiStyle}
        language={language}
        isOpen={settingsOpen}
        onClose={onCloseSettings}
        onSave={onSaveSettings}
      />
    </div>
  );
}

export default App;
