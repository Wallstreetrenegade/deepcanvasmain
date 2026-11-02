import { Suspense } from 'react';
import { useFeatureStore } from '../../stores/featureStore';
import { FEATURE_WORKSPACE_COMPONENTS } from './featureRegistry';
import './FeatureWorkspace.css';

interface FeatureWorkspaceProps {
  onExit: () => void;
}

export function FeatureWorkspace({ onExit }: FeatureWorkspaceProps) {
  const activeFeature = useFeatureStore((state) => state.activeFeature);
  const closeFeature = useFeatureStore((state) => state.closeFeature);

  if (!activeFeature) {
    return null;
  }

  const ActiveWorkspace = FEATURE_WORKSPACE_COMPONENTS[activeFeature];
  const handleExit = () => {
    closeFeature();
    onExit();
  };

  return (
    <div className="feature-workspace">
      <div className="feature-workspace__body">
        <Suspense
          fallback={
            <div className="feature-placeholder animate-rise">
              <div className="feature-placeholder__eyebrow">Loading Module</div>
              <h2 className="feature-placeholder__title">Preparing workspace</h2>
              <p className="feature-placeholder__body">
                Deep Canvas is loading this feature bundle now.
              </p>
            </div>
          }
        >
          <ActiveWorkspace onExit={handleExit} />
        </Suspense>
      </div>
    </div>
  );
}