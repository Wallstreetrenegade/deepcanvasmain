import { FEATURE_LABELS, type FeatureKey } from '../../stores/featureStore';

interface FeatureModuleShellProps {
  feature: FeatureKey;
}

export function FeatureModuleShell({ feature }: FeatureModuleShellProps) {
  return (
    <div className="feature-placeholder animate-rise">
      <div className="feature-placeholder__eyebrow">Module Shell</div>
      <h2 className="feature-placeholder__title">{FEATURE_LABELS[feature]}</h2>
      <p className="feature-placeholder__body">
        This page is now wired into the workspace. We can build the full {FEATURE_LABELS[feature]} module next without changing the navigation model.
      </p>
    </div>
  );
}