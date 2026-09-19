import { Bold, Italic, List, Heading3 } from 'lucide-react';

interface EditorToolbarProps {
  onFormat: (command: string, value?: string) => void;
}

export function EditorToolbar({ onFormat }: EditorToolbarProps) {
  const handleFormat = (command: string, value?: string) => {
    onFormat(command, value);
  };

  return (
    <div className="flex items-center space-x-2 p-2 bg-bg border border-border rounded-t-md">
      <button
        type="button"
        onClick={() => handleFormat('bold')}
        className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
        title="Bold (Ctrl+B)"
      >
        <Bold className="w-4 h-4 text-text" />
      </button>

      <button
        type="button"
        onClick={() => handleFormat('italic')}
        className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
        title="Italic (Ctrl+I)"
      >
        <Italic className="w-4 h-4 text-text" />
      </button>

      <div className="w-px h-6 bg-border" />

      <button
        type="button"
        onClick={() => handleFormat('formatBlock', 'h2')}
        className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
        title="Heading 2"
      >
        <Heading3 className="w-4 h-4 text-text" />
      </button>

      <button
        type="button"
        onClick={() => handleFormat('formatBlock', 'h3')}
        className="px-2 py-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors text-sm font-medium text-text"
        title="Heading 3"
      >
        H3
      </button>

      <div className="w-px h-6 bg-border" />

      <button
        type="button"
        onClick={() => handleFormat('insertUnorderedList')}
        className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
        title="Bullet List"
      >
        <List className="w-4 h-4 text-text" />
      </button>

      <button
        type="button"
        onClick={() => handleFormat('insertOrderedList')}
        className="px-2 py-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors text-sm font-medium text-text"
        title="Numbered List"
      >
        1-2-3
      </button>
    </div>
  );
}
