import React, {ChangeEvent, FormEvent, useState} from 'react';

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSave: (userName: string, userId: string, aiName: string) => void;
}

export const SettingsModal = ({ isOpen, onClose, onSave }: SettingsModalProps)=> {
  const [formData, setFormData] = useState({
    aiName: 'Jenny',
    userName: 'Paul',
    userId: 'fake',
  });

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSave(formData.userName, formData.userId, formData.aiName);
    onClose();
  };

  return (
    <div className={`fixed inset-0 z-10 overflow-y-auto ${isOpen ? 'block' : 'hidden'}`}>
      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 transition-opacity" aria-hidden="true">
          <div className="absolute inset-0 bg-gray-500 opacity-75"></div>
        </div>

        <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

        <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
          <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
            <form onSubmit={handleSubmit} className="p-2 min-w-72">
              <label className="block text-gray-700 text-sm font-bold mb-2" htmlFor="userName">
                Your Name
              </label>
              <input type="text"
                     name="userName"
                     className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                     value={formData.userName}
                     onChange={handleChange}/>
              <label className="block text-gray-700 text-sm font-bold my-2" htmlFor="aiName">
                AI Name
              </label>
              <input type="text"
                     name="aiName"
                     className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                     value={formData.aiName}
                     onChange={handleChange}/>
              <label className="block text-gray-700 text-sm font-bold my-2" htmlFor="userId">
                Memory Key
              </label>
              <input type="text"
                     name="userId"
                     className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                     value={formData.userId}
                     onChange={handleChange}/>
              <div className="flex flex-col items-end mt-4">
                <button type="submit"
                        className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
