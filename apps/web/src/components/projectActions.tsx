import { Archive, ArrowRight, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { endpoints } from '../api/endpoints.ts';
import { DeleteProject, RenameProject } from '../pages/Layout.tsx';
import { useProjects } from '../stores/projects.ts';
import { ContextMenu, useContextMenu } from './ContextMenu.tsx';

/**
 * Everything you can do to a project, in one place.
 *
 * These actions used to exist only behind a right-click on the row in the sidebar,
 * which is a fine shortcut and a terrible only way: nothing on the screen said the
 * menu was there, so renaming a project was a feature you had to already know about.
 * Now the same menu hangs off a button on the project card and on the project's own
 * page, and the right-click still works for anyone who tries it.
 *
 * A hook rather than a component because the trigger differs in each place, but the
 * menu, the dialogs and what they do must not.
 */
export function useProjectActions({
  id,
  name,
  slug,
  services,
  includeOpen,
  onDeleted,
}: {
  id: string;
  name: string;
  slug: string;
  /** Only the count matters; the delete dialog says how much is about to go. */
  services: number;
  /** Worth offering from a list, pointless when you are already looking at it. */
  includeOpen?: boolean;
  /** Deleting the project you are standing on has to move you somewhere that exists. */
  onDeleted?: () => void;
}) {
  const navigate = useNavigate();
  const load = useProjects((s) => s.load);
  const menu = useContextMenu();
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const element = (
    <>
      <ContextMenu
        at={menu.at}
        onClose={menu.close}
        items={[
          ...(includeOpen
            ? [
                {
                  label: 'Open',
                  icon: <ArrowRight className="h-3.5 w-3.5" />,
                  onSelect: () => navigate(`/p/${slug}`),
                },
              ]
            : []),
          {
            label: 'Rename',
            icon: <Pencil className="h-3.5 w-3.5" />,
            onSelect: () => setDialog('rename'),
          },
          {
            label: 'Back it up',
            icon: <Archive className="h-3.5 w-3.5" />,
            separated: true,
            onSelect: async () => {
              setNote('Copying…');
              const ok = await endpoints
                .createBackup(id)
                .then(() => true)
                .catch(() => false);
              setNote(ok ? 'Copied' : 'Failed');
              setTimeout(() => setNote(null), 4000);
            },
          },
          {
            label: 'Delete',
            icon: <Trash2 className="h-3.5 w-3.5" />,
            danger: true,
            separated: true,
            onSelect: () => setDialog('delete'),
          },
        ]}
      />

      {dialog === 'rename' && (
        <RenameProject
          id={id}
          name={name}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load();
          }}
        />
      )}

      {dialog === 'delete' && (
        <DeleteProject
          id={id}
          name={name}
          services={services}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load();
            onDeleted?.();
          }}
        />
      )}
    </>
  );

  return { onContextMenu: menu.onContextMenu, openFrom: menu.openFrom, element, note };
}
