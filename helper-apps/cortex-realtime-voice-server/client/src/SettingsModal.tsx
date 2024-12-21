import {ChangeEvent, FormEvent, useState} from 'react';
import type { Voice, OpenAIVoice, AzureVoice } from '../../src/realtime/realtimeTypes';

type SettingsModalProps = {
  aiName: string;
  userName: string;
  userId: string;
  voice: Voice;
  aiStyle: string;
  language: string;
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

// Define voice lists
const openaiVoices: OpenAIVoice[] = ['alloy', 'echo', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'];
const azureVoices: AzureVoice[] = ['amuch', 'dan', 'elan', 'marilyn', 'meadow', 'breeze', 'cove', 'ember', 'jupiter', 'alloy', 'echo', 'shimmer'];

// Check if we're using Azure based on the environment variable
const isAzure = import.meta.env.VITE_VOICE_PROVIDER === 'azure';

export const SettingsModal = (
  {aiName, userName, userId, voice, aiStyle, language, isOpen, onClose, onSave}: SettingsModalProps
) => {
  const [formData, setFormData] = useState<SettingsData>({
    aiName,
    userName,
    userId,
    language: 'en',
    aiMemorySelfModify: false,
    aiStyle: 'Anthropic',
    voice: 'alloy'
  });

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData({
      ...formData,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSave(formData);
    onClose();
  };

  return (
    <div className={`fixed inset-0 z-50 overflow-y-auto ${isOpen ? 'block' : 'hidden'}`}>
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 transition-opacity bg-gray-900 bg-opacity-75 backdrop-blur-sm" aria-hidden="true" />

        <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

        <div className="inline-block w-full max-w-md p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-gray-800 border border-gray-700/50 rounded-2xl shadow-2xl sm:align-middle">
          <h3 className="text-lg font-medium leading-6 text-gray-100 mb-4">
            System Configuration
          </h3>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Your Name
              </label>
              <input
                type="text"
                name="userName"
                className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                value={formData.userName}
                onChange={handleChange}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                AI Name
              </label>
              <input
                type="text"
                name="aiName"
                className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                value={formData.aiName}
                onChange={handleChange}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Voice
              </label>
              <select
                name="voice"
                className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                value={formData.voice}
                onChange={handleChange}
              >
                {isAzure ? (
                  <optgroup label="Azure Voices">
                    {azureVoices.map(voice => (
                      <option key={voice} value={voice}>
                        {voice.charAt(0).toUpperCase() + voice.slice(1)}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  <optgroup label="OpenAI Voices">
                    {openaiVoices.map(voice => (
                      <option key={voice} value={voice}>
                        {voice.charAt(0).toUpperCase() + voice.slice(1)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Language
              </label>
              <select
                name="language"
                className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                value={formData.language}
                onChange={handleChange}
              >
                <option value="en">English</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
                <option value="it">Italiano</option>
                <option value="pt">Português</option>
                <option value="ru">Русский</option>
                <option value="zh">中文</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                AI Style
              </label>
              <select
                name="aiStyle"
                className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                value={formData.aiStyle}
                onChange={handleChange}
              >
                <option value="Anthropic">Anthropic</option>
                <option value="OpenAI">OpenAI</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Memory Key
              </label>
              <input
                type="text"
                name="userId"
                className="w-full px-3 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                value={formData.userId}
                onChange={handleChange}
              />
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                id="aiMemorySelfModify"
                name="aiMemorySelfModify"
                checked={formData.aiMemorySelfModify}
                onChange={handleChange}
                className="w-4 h-4 border-gray-600 rounded bg-gray-700 text-cyan-500 focus:ring-cyan-500/50"
              />
              <label htmlFor="aiMemorySelfModify" className="ml-2 text-sm text-gray-300">
                Enable AI Memory Self-Modification
              </label>
            </div>

            <div className="flex justify-end mt-6">
              <button
                type="submit"
                className="px-4 py-2 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white rounded-lg shadow-lg shadow-cyan-500/20 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              >
                Save Configuration
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
