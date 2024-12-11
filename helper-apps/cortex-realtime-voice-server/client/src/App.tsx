import {useEffect, useState} from 'react';
import ClipLoader from "react-spinners/ClipLoader";
import Chat from "./chat/Chat";
import {SettingsModal} from "./SettingsModal";

function App() {
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  const [userId, setUserId] = useState('');
  const [aiName, setAiName] = useState('Jarvis');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const onCloseSettings = () => setSettingsOpen(false);
  const onSaveSettings = (name: string, id: string, ai: string) => {
    console.log('Saving settings', name, id, ai);
    setUserName(name);
    localStorage.setItem('userName', name);

    let newUserId = id;
    if (!newUserId || newUserId.length === 0) {
      newUserId = Math.random().toString(36).substring(7);
    }
    setUserId(newUserId);
    localStorage.setItem('userId', newUserId);
    setAiName(ai);
    localStorage.setItem('aiName', ai);
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
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-800 dark:text-white min-w-72 flex justify-center items-center">
        <ClipLoader color={'#00FF'} loading={true} size={150}/>
      </div>
    );
  }


  return (
    <div className="bg-white dark:bg-slate-800 dark:text-white min-w-72">
      <h1 className='text-xl font-bold text-center text-white p-3 bg-black'>AI Chat</h1>
      <div className="flex justify-end text-2xl m-4 -mt-11" onClick={() => setSettingsOpen(true)}>⚙️</div>
      {userName && userName.length > 0 && (
        <Chat userId={userId} userName={userName} aiName={aiName}/>
      )}
      <SettingsModal aiName={aiName}
                     userName={userName}
                     userId={userId}
                     isOpen={settingsOpen}
                     onClose={onCloseSettings}
                     onSave={onSaveSettings}/>
    </div>
  );
}

export default App;
