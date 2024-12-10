type ChatBubbleLeftProps = {
  name: string;
  message: string;
};

export const ChatBubbleLeft = ({name, message}: ChatBubbleLeftProps) => {
  return (
    <div className="flex items-start justify-start p-3">
      <div className="flex flex-col leading-1.5 p-4 border-gray-200 bg-gray-900 rounded-e-xl rounded-es-xl mr-20">
        <div className="flex items-start justify-start space-x-2">
          <p className="text-sm font-semibold text-gray-100">{name}</p>
        </div>
        <p className="text-sm font-normal py-2.5 text-gray-100">{message}</p>
      </div>
    </div>
  )
}
