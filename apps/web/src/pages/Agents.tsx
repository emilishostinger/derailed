import { ApiTokens } from '../components/ApiTokens.tsx';
import { PageHeader } from './Layout.tsx';

/**
 * Coding agents.
 *
 * This was a section near the bottom of Settings, which is where you put a checkbox,
 * not a way of driving the whole server from the editor you are already in. It is one
 * of the few things here nothing else does, so it gets a place in the sidebar and a
 * page of its own rather than being something you find by scrolling.
 */
export function Agents() {
  return (
    <>
      <PageHeader title="Coding agents" subtitle="Drive this server from your editor, over MCP" />
      {/* No padding here: with nothing set up yet the whole area is an empty state,
          and its backdrop is meant to reach the header rather than stop short of it.
          The list state brings its own width and padding. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ApiTokens />
      </div>
    </>
  );
}
