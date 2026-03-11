/**
 * MilkdownEditor - Markdown 所见即所得编辑
 * 使用 @milkdown/react + @milkdown/kit，无工具栏，适配亮/暗主题。
 */

import React, { useRef } from 'react';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { Editor } from '@milkdown/kit/core';
import { rootCtx, defaultValueCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { listener, listenerCtx, ListenerManager } from '@milkdown/plugin-listener';
import type { Ctx } from '@milkdown/ctx';

import '@milkdown/kit/prose/view/style/prosemirror.css';
import { PROSE_CLASSES_MARKDOWN } from '../../lib/markdownRender';

export interface MilkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  className?: string;
  height?: string;
}

function MilkdownInner({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEditor(
    (root) => {
      const manager = new ListenerManager();
      manager.markdownUpdated((_, markdown) => {
        onChangeRef.current?.(markdown);
      });
      const editor = Editor.make();
      editor
        .config((ctx: Ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, valueRef.current || '');
          ctx.set(listenerCtx, manager);
        })
        .use(commonmark)
        .use(gfm)
        .use(listener);
      return editor;
    },
    [value]
  );

  return <Milkdown />;
}

export function MilkdownEditor({ value, onChange, readOnly = false, className, height = '100%' }: MilkdownEditorProps) {
  return (
    <div
      className={className}
      style={{ height }}
      data-milkdown-wrapper
      data-read-only={readOnly ? 'true' : undefined}
    >
      <MilkdownProvider>
        <div
          className={`milkdown-editor h-full overflow-auto p-6 bg-background ${PROSE_CLASSES_MARKDOWN}`}
          style={readOnly ? { userSelect: 'none', caretColor: 'transparent' } : undefined}
          onKeyDown={readOnly ? (e) => e.preventDefault() : undefined}
          onKeyPress={readOnly ? (e) => e.preventDefault() : undefined}
          onCut={readOnly ? (e) => e.preventDefault() : undefined}
          onPaste={readOnly ? (e) => e.preventDefault() : undefined}
        >
          <MilkdownInner value={value} onChange={readOnly ? undefined : onChange} />
        </div>
      </MilkdownProvider>
    </div>
  );
}

export default MilkdownEditor;
