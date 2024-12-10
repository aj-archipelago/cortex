import React from 'react';
import Chat from "./chat/Chat";

function App() {
  return (
    <div className="bg-white dark:bg-slate-800 dark:text-white">
      <Chat userId={'fake'} userName={'Paul'} aiName={'Joy'} />
    </div>
  );
}

export default App;
