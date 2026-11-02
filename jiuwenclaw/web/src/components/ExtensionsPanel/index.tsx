import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { webRequest } from '../../services/webClient';
import './ExtensionsPanel.css';

interface RailExtension {
  name: string;
  class_name: string;
  enabled: boolean;
  description: string;
  priority: number;
}

interface ExtensionsPanelProps {
  isConnected: boolean;
}

export function ExtensionsPanel({ isConnected }: ExtensionsPanelProps) {
  const { t } = useTranslation();
  const [extensions, setExtensions] = useState<RailExtension[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState('');

  const loadExtensions = useCallback(async () => {
    if (!isConnected) return;

    setLoading(true);
    setError(null);

    try {
      const payload = await webRequest<{ extensions: RailExtension[] }>(
        'extensions.list',
        {}
      );

      if (payload?.extensions) {
        setExtensions(payload.extensions);
      } else {
        throw new Error('Failed to load the extension list');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [isConnected]);

  useEffect(() => {
    loadExtensions();
  }, [loadExtensions]);

  const handleImport = useCallback(async () => {
    if (!folderPath.trim()) {
      setError('Enter an extension folder path');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const extension = await webRequest<RailExtension>('extensions.import', {
        folder_path: folderPath,
      });

      if (extension) {
        setExtensions((prev) => [...prev, extension]);
        setFolderPath('');
      } else {
        throw new Error('Failed to import the extension');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [folderPath]);

  const handleDelete = useCallback(
    async (name: string) => {
      if (!confirm(`Delete extension "${name}"?`)) {
        return;
      }

      setLoading(true);
      setError(null);

      try {
        await webRequest('extensions.delete', { name });
        setExtensions((prev) => prev.filter((ext) => ext.name !== name));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const handleToggle = useCallback(
    async (name: string, enabled: boolean) => {
      const previousState = extensions.find(ext => ext.name === name);
      if (!previousState) return;

      setExtensions(prev =>
        prev.map(ext => (ext.name === name ? { ...ext, enabled } : ext))
      );

      setLoading(true);
      setError(null);

      try {
        const extension = await webRequest<RailExtension>('extensions.toggle', { name, enabled });
        if (extension) {
          setExtensions(prev =>
            prev.map(ext => (ext.name === name ? extension : ext))
          );
        } else {
          throw new Error('Failed to change the extension status');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setExtensions(prev =>
          prev.map(ext => (ext.name === name ? previousState : ext))
        );
      } finally {
        setLoading(false);
      }
    },
    [extensions]
  );

  return (
    <div className="extensions-panel">
      <div className="extensions-panel__title">
        {t('extensions.title', 'Extensions')}
      </div>
      <p className="extensions-panel__description">
        {t('extensions.description', 'Manage custom Rail extensions')}
      </p>

      {error && (
        <div className="extensions-panel__error">
          {error}
        </div>
      )}

      <div className="extensions-panel__import-section">
        <h3 className="extensions-panel__import-title">
          {t('extensions.importTitle', 'Import Extension')}
        </h3>
        <div className="extensions-panel__import-layout">
          <div className="extensions-panel__import-row">
            <input
              type="text"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="Enter an extension folder path (for example: D:/extensions/my_extension)"
              disabled={loading || !isConnected}
              className="extensions-panel__path-input"
            />
            <button
              onClick={handleImport}
              disabled={loading || !isConnected || !folderPath.trim()}
              className="extensions-panel__import-button"
            >
              {loading ? 'Importing...' : t('extensions.importButton', 'Import')}
            </button>
          </div>
          <span className="extensions-panel__import-hint">
            {t('extensions.importHint', 'Folder requirements: 1) English name 2) Contains the rail.py entry file')}
          </span>
        </div>
      </div>

      <div className="extensions-panel__list">
        {loading && extensions.length === 0 && (
          <div className="extensions-panel__loading">
            {t('common.loading', 'Loading...')}
          </div>
        )}

        {!loading && extensions.length === 0 && (
          <div className="extensions-panel__empty">
            {t('extensions.noExtensions', 'No extensions')}
          </div>
        )}

        {extensions.length > 0 && (
          <div>
            {extensions.map((ext) => (
              <div key={ext.name} className="extensions-panel__item">
                <div className="extensions-panel__item-content">
                  <div className="extensions-panel__item-header">
                    <span className="extensions-panel__item-name">
                      {ext.name}
                    </span>
                    <span className="extensions-panel__item-class">
                      {ext.class_name}
                    </span>
                  </div>
                  {ext.description && (
                    <p className="extensions-panel__item-description">
                      {ext.description}
                    </p>
                  )}
                </div>

                <div className="extensions-panel__item-actions">
                  <label className="extensions-panel__toggle">
                    <input
                      type="checkbox"
                      checked={ext.enabled}
                      onChange={(e) =>
                        handleToggle(ext.name, e.target.checked)
                      }
                      disabled={loading || !isConnected}
                      className="extensions-panel__toggle-input"
                      aria-label={`Toggle extension ${ext.name}`}
                      title={`Toggle extension ${ext.name}`}
                    />
                    <div
                      className={`extensions-panel__toggle-track ${
                        ext.enabled ? 'enabled' : ''
                      }`}
                    >
                      <div className="extensions-panel__toggle-thumb" />
                    </div>
                  </label>

                  <button
                    onClick={() => handleDelete(ext.name)}
                    disabled={loading || !isConnected}
                    className="extensions-panel__delete-button"
                  >
                    {t('extensions.deleteButton', 'Delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="extensions-panel__help">
        <h4 className="extensions-panel__help-title">
          {t('extensions.helpTitle', 'Usage Guide')}
        </h4>
        <ul className="extensions-panel__help-list">
          <li>
            {t('extensions.help0', 'The extension folder must contain rail.py as the entry file')}
          </li>
          <li>
            {t(
              'extensions.help1',
              'Rail extension files must inherit from DeepAgentRail or AgentRail base classes'
            )}
          </li>
          <li>
            {t(
              'extensions.help2',
              'Extension folders are saved under ~/.jiuwenclaw/agent/jiuwenclaw_workspace/extensions/'
            )}
          </li>
        </ul>
      </div>
    </div>
  );
}
