/**
 * The handbook, as it appears inside the dashboard.
 *
 * Same files as `docs/` in the repository rather than a second copy of the words.
 * Two copies of an explanation is one copy that quietly goes stale, and the stale
 * one is always the one somebody reads.
 *
 * What differs is which of them appear and how much of each. The reader here has
 * already installed Derailed and is looking at it, so pages about getting it onto a
 * server, and sections about compiling the binary, are left out. Everything kept is
 * about using the thing they are currently inside.
 */
export interface HelpTopic {
  slug: string;
  /** Shown in the list. Occasionally shorter than the document's own title. */
  title: string;
  /** One line, so the index is browsable without opening anything. */
  blurb: string;
  /** Headings dropped along with everything beneath them. */
  omit?: string[];
}

export interface HelpGroup {
  title: string;
  topics: HelpTopic[];
}

export const HELP: HelpGroup[] = [
  {
    title: 'Getting started',
    topics: [
      {
        slug: 'quickstart',
        title: 'First steps',
        blurb: 'From an empty dashboard to a site on your own domain.',
        // Derailed is plainly already installed by the time this is being read.
        omit: ['1. Install'],
      },
      {
        slug: 'deploying',
        title: 'Deploying',
        blurb: 'GitHub repositories, zip uploads, and how the build is worked out.',
      },
      {
        slug: 'apps',
        title: 'Ready-made apps',
        blurb: 'What is in the catalogue and what each one needs.',
      },
    ],
  },
  {
    title: 'Running things',
    topics: [
      {
        slug: 'domains',
        title: 'Domains and HTTPS',
        blurb: 'Pointing a domain at an app, and where certificates come from.',
      },
      {
        slug: 'databases',
        title: 'Databases',
        blurb: 'Creating one, connecting an app to it, and reaching it yourself.',
      },
      {
        slug: 'storage',
        title: 'Storage',
        blurb: 'What survives a deploy, and what a deploy throws away.',
      },
      {
        slug: 'backups',
        title: 'Backups',
        blurb: 'What is in one, how many are kept, and how restoring works.',
      },
      {
        slug: 'forms',
        title: 'Forms',
        blurb: 'Working forms on a plain site: one attribute, no backend.',
      },
      {
        slug: 'analytics',
        title: 'Visitor figures',
        blurb: 'How visitors are counted and what is deliberately not kept.',
      },
    ],
  },
  {
    title: 'Beyond the dashboard',
    topics: [
      {
        slug: 'mcp',
        title: 'Coding agents',
        blurb: 'Letting Claude Code, Cursor or Codex drive this server.',
      },
      {
        slug: 'api',
        title: 'The API',
        blurb: 'Every route the dashboard uses is a route you can call.',
      },
      {
        slug: 'cli',
        title: 'The command line',
        blurb: 'What the binary can do over SSH when the dashboard cannot help.',
      },
    ],
  },
  {
    title: 'Reference',
    topics: [
      {
        slug: 'troubleshooting',
        title: 'When something goes wrong',
        blurb: 'The failures people actually hit, and what to do about each.',
      },
      {
        slug: 'faq',
        title: 'Questions people ask',
        blurb: 'Short answers, including several honest ones.',
      },
      {
        slug: 'security',
        title: 'Security',
        blurb: 'How sign-in, secrets and the network are handled.',
      },
      {
        slug: 'architecture',
        title: 'How it works',
        blurb: 'The shape of Derailed, for when you want to know what it is doing.',
        // Compiling it, the source tree and the house style are a contributor's
        // errand. "Building" stays: despite the name it is about how Derailed builds
        // your app, which is the most useful section on the page.
        omit: ['One binary', 'Layout', 'Conventions', 'Verifying'],
      },
    ],
  },
];

export const TOPICS: HelpTopic[] = HELP.flatMap((group) => group.topics);

export function findTopic(slug: string | undefined): HelpTopic | null {
  return TOPICS.find((topic) => topic.slug === slug) ?? null;
}
