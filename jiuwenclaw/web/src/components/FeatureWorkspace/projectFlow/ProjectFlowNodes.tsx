import { memo, useEffect, useMemo, useRef } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ProjectFlowDrawingStroke, ProjectFlowNode } from '../../../stores/projectFlowStore';

function getKindLabel(kind: ProjectFlowNode['data']['kind']): string {
  switch (kind) {
    case 'project':
      return 'Task';
    case 'code':
      return 'Code';
    case 'story':
      return 'Scene';
    case 'art':
      return 'Mood';
    case 'document':
      return 'Document';
    case 'url':
      return 'URL';
    case 'image':
      return 'Image';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'drawing':
      return 'Sketch';
    case 'ai':
      return 'AI';
    case 'workflow':
      return 'Run';
    case 'imageGenerator':
      return 'Image Gen';
    case 'videoGenerator':
      return 'Video Gen';
    case 'note':
    default:
      return 'Note';
  }
}

function getUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace('www.', '');
  } catch {
    return 'Paste link';
  }
}

function SketchPreview({ strokes, background }: { strokes: ProjectFlowDrawingStroke[]; background: string }) {
  const sketchRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    sketchRef.current?.style.setProperty('--drawing-background', background);
  }, [background]);

  return (
    <div ref={sketchRef} className="project-flow-node__sketch">
      {strokes.length > 0 ? (
        <svg viewBox="0 0 300 180" className="project-flow-node__sketch-svg" preserveAspectRatio="none">
          {strokes.slice(0, 24).map((stroke) => (
            <path
              key={stroke.id}
              d={stroke.path}
              fill="none"
              stroke={stroke.color}
              strokeWidth={stroke.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </svg>
      ) : (
        <div className="project-flow-node__empty-state">Draw here</div>
      )}
    </div>
  );
}

export const ProjectFlowCanvasNode = memo(function ProjectFlowCanvasNode({ data, selected }: NodeProps<ProjectFlowNode>) {
  const completedCount = data.checklist.filter((item) => item.done).length;
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    nodeRef.current?.style.setProperty('--node-accent', data.accent);
  }, [data.accent]);

  useEffect(() => {
    const percent = data.checklist.length === 0 ? 0 : (completedCount / data.checklist.length) * 100;
    progressRef.current?.style.setProperty('--project-progress', `${percent}%`);
  }, [completedCount, data.checklist.length]);

  const mediaPreview = useMemo(() => {
    if (data.kind === 'image') {
      return data.mediaSrc ? <img src={data.mediaSrc} alt={data.title} className="project-flow-node__media" /> : <div className="project-flow-node__empty-state">Upload image</div>;
    }

    if (data.kind === 'video') {
      return data.mediaSrc ? <video src={data.mediaSrc} className="project-flow-node__media" muted playsInline /> : <div className="project-flow-node__empty-state">Upload video</div>;
    }

    if (data.kind === 'audio') {
      return data.mediaSrc ? <audio src={data.mediaSrc} className="project-flow-node__media" controls preload="metadata" /> : <div className="project-flow-node__empty-state">Upload audio</div>;
    }

    if (data.kind === 'imageGenerator') {
      return data.mediaResultUrl ? <img src={data.mediaResultUrl} alt={data.title} className="project-flow-node__media" /> : <div className="project-flow-node__empty-state">Generate image</div>;
    }

    if (data.kind === 'videoGenerator') {
      return data.mediaResultUrl ? <video src={data.mediaResultUrl} className="project-flow-node__media" muted playsInline controls /> : <div className="project-flow-node__empty-state">Generate video</div>;
    }

    return null;
  }, [data.kind, data.mediaResultUrl, data.mediaSrc, data.title]);
  const shouldShowPlainBody = !(['document', 'url', 'drawing', 'image', 'video', 'audio', 'imageGenerator', 'videoGenerator'] as ProjectFlowNode['data']['kind'][]).includes(data.kind);

  return (
    <div ref={nodeRef} className={`project-flow-node project-flow-node--${data.kind} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="project-flow-node__handle" />
      <Handle type="target" position={Position.Left} className="project-flow-node__handle" />
      <Handle type="source" position={Position.Right} className="project-flow-node__handle" />
      <Handle type="source" position={Position.Bottom} className="project-flow-node__handle" />

      <div className="project-flow-node__card">
        <div className="project-flow-node__meta-row">
          <div className="project-flow-node__drag">
            <span className="project-flow-node__icon">{data.icon}</span>
            <div className="project-flow-node__heading">
              <strong>{data.title}</strong>
              <span>{data.subtitle || getKindLabel(data.kind)}</span>
            </div>
          </div>
          <span className="project-flow-node__kind-pill">{getKindLabel(data.kind)}</span>
        </div>

        {data.kind === 'image' || data.kind === 'video' || data.kind === 'audio' || data.kind === 'imageGenerator' || data.kind === 'videoGenerator' ? <div className="project-flow-node__media-shell">{mediaPreview}</div> : null}

        {data.kind === 'drawing' ? <SketchPreview strokes={data.drawingStrokes} background={data.drawingBackground} /> : null}

        {data.kind === 'document' ? (
          <div className="project-flow-node__resource project-flow-node__resource--document">
            <span className="project-flow-node__resource-main">{data.fileName || 'No file'}</span>
            <span>{data.fileType || 'Upload document'}</span>
            <span>{data.fileSizeLabel || '0 KB'}</span>
          </div>
        ) : null}

        {data.kind === 'url' ? (
          <div className="project-flow-node__resource project-flow-node__resource--url">
            <span className="project-flow-node__resource-main">{getUrlLabel(data.url)}</span>
            <span className="project-flow-node__resource-url">{data.url || 'https://'}</span>
          </div>
        ) : null}

        {data.kind === 'code' ? (
          <pre className="project-flow-node__code">{data.body}</pre>
        ) : data.kind === 'ai' ? (
          <div className="project-flow-node__ai-block">
            <p className="project-flow-node__body">
              {data.aiMessages.length > 0
                ? data.aiMessages[data.aiMessages.length - 1]?.content || data.aiPrompt || data.body
                : data.aiPrompt || data.body}
            </p>
            {data.aiResult ? <pre className="project-flow-node__result">{data.aiResult}</pre> : null}
          </div>
        ) : data.kind === 'workflow' ? (
          <div className="project-flow-node__ai-block">
            <p className="project-flow-node__body">{data.body}</p>
            {data.workflowResult ? <pre className="project-flow-node__result">{data.workflowResult}</pre> : null}
          </div>
        ) : data.kind === 'imageGenerator' || data.kind === 'videoGenerator' ? (
          <div className="project-flow-node__generator-block">
            <p className="project-flow-node__body">{data.mediaPrompt || data.body}</p>
            <span className="project-flow-node__status">{data.mediaStatus || 'Ready'}</span>
          </div>
        ) : data.kind === 'audio' ? (
          <div className="project-flow-node__generator-block">
            <p className="project-flow-node__body">{data.audioTranscript || data.body}</p>
            <span className="project-flow-node__status">{data.audioDurationLabel || 'Audio input'}</span>
          </div>
        ) : data.kind === 'project' ? (
          <div className="project-flow-node__progress-block">
            <div className="project-flow-node__progress-bar">
              <span ref={progressRef} className="project-flow-node__progress-fill" />
            </div>
            <p className="project-flow-node__body">{data.body}</p>
          </div>
        ) : data.kind === 'story' ? (
          <div className="project-flow-node__story-frame">
            <span className="project-flow-node__story-index">Frame</span>
            <p className="project-flow-node__body">{data.body}</p>
          </div>
        ) : data.kind === 'art' ? (
          <div className="project-flow-node__art-block">
            <p className="project-flow-node__body">{data.body}</p>
          </div>
        ) : shouldShowPlainBody ? (
          <p className="project-flow-node__body">{data.body}</p>
        ) : null}

        {data.checklist.length > 0 ? (
          <div className="project-flow-node__checklist">
            {data.checklist.slice(0, 3).map((item) => (
              <div key={item.id} className={`project-flow-node__check ${item.done ? 'is-done' : ''}`}>
                <span>{item.done ? '✓' : '○'}</span>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="project-flow-node__footer">
          {data.tags.length > 0 ? (
            <div className="project-flow-node__tags">
              {data.tags.slice(0, 3).map((tag) => (
                <span key={tag} className="project-flow-node__tag">
                  {tag}
                </span>
              ))}
            </div>
          ) : (
            <span className="project-flow-node__hint">Double-click for deeper edit</span>
          )}
          {data.checklist.length > 0 ? <span className="project-flow-node__count">{completedCount}/{data.checklist.length}</span> : null}
        </div>
      </div>
    </div>
  );
});
