import React, {useEffect} from 'react';
import Chat from "./chat/Chat";
import {SettingsModal} from "./SettingsModal";

function App() {
  const [userName, setUserName] = React.useState('ME');
  const [userId, setUserId] = React.useState('123-456-789');
  const [aiName, setAiName] = React.useState('Jarvis');
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const onCloseSettings = () => setSettingsOpen(false);
  const onSaveSettings = (userName: string, userId: string, aiName: string) => {
    console.log('Saving settings', userName, userId, aiName);
    setUserName(userName);
    localStorage.setItem('userName', userName);
    setUserId(userId);
    localStorage.setItem('userId', userId);
    setAiName(aiName);
    localStorage.setItem('aiName', aiName);
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
  }, []);

  return (
    <div className="bg-white dark:bg-slate-800 dark:text-white min-w-72">
      <h1 className='text-xl font-bold text-center text-white p-3 bg-black'>AI Chat</h1>
      <div className="flex justify-end text-2xl m-4 -mt-11" onClick={() => setSettingsOpen(true)}>⚙️</div>
      <Chat userId={userId} userName={userName} aiName={aiName}/>
      <SettingsModal isOpen={settingsOpen} onClose={onCloseSettings} onSave={onSaveSettings}/>
    </div>
  );
}

export default App;
