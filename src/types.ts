// ============================================================
// PulseCLI — src/types.ts
// Mirrors the Atlas Pulse API contract exactly.
// Field names match raw Prisma camelCase; enum values UPPERCASE.
// ============================================================

// ---- Enums ----

export type Category = "TASK" | "BUG";

export type Status = "OPEN" | "IN_PROGRESS" | "STAGING" | "RESOLVED" | "CLOSED";

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type Module =
  | "SHELL"
  | "FINANCE"
  | "HR"
  | "GRAPHICS"
  | "TABANG"
  | "REPORTING"
  | "VENDOR"
  | "ICDC"
  | "LEGACY_ALIGN"
  | "INVENTORY"
  | "SUPPLY_CHAIN"
  | "QHP"
  | "ISMC"
  | "CLEARING_HOUSE"
  | "POS_CENTRAL"
  | "MARKETING"
  | "ITEM_MANAGEMENT"
  | "PULSE"
  | "MARITES";

export type LinkType = "RELATED" | "BLOCKS" | "BLOCKED_BY";

// ---- Shared sub-types ----

/** Minimal user reference: id + name only */
export interface UserRef {
  id: string;
  name: string;
}

/** Extended user reference: id + name + email */
export interface UserRefFull {
  id: string;
  name: string;
  email: string;
}

export interface SprintRef {
  id: string;
  name: string;
  status: string;
}

export interface MilestoneRef {
  id: string;
  name: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  createdAt?: string;
}

export interface Attachment {
  id: string;
  ticketId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface Comment {
  id: string;
  ticketId: string;
  authorId: string;
  content: string;
  createdAt: string;
  author: UserRef;
}

export interface Activity {
  id: string;
  kind: string;
  oldValue: string | null;
  newValue: string | null;
  meta: unknown;
  createdAt: string;
  actor: UserRef | null;
}

export interface IssueLink {
  id: string;
  type: LinkType;
  direction: "out" | "in";
  otherIssue: {
    id: string;
    title: string;
    status: Status;
  };
}

// ---- Issue list item (GET /api/issues array element) ----

export interface IssueListItem {
  id: string;
  key: string;
  title: string;
  description: string;
  category: Category;
  status: Status;
  priority: Priority;
  module: Module | null;
  milestoneId: string | null;
  sprintId: string | null;
  reporterId: string;
  assigneeId: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  reporter: UserRef | null;
  assignee: UserRef | null;
  sprint: SprintRef | null;
  labels: Label[];
  _count: {
    attachments: number;
    comments: number;
    linkedIssues: number;
  };
}

// ---- Issue detail (GET /api/issues/{keyOrId}) ----

export interface IssueDetail
  extends Omit<IssueListItem, "reporter" | "assignee" | "_count"> {
  reporter: UserRefFull | null;
  assignee: UserRefFull | null;
  milestone: MilestoneRef | null;
  sprint: SprintRef | null;
  attachments: Attachment[];
  comments: Comment[];
  activity: Activity[];
  labels: Label[];
  links: IssueLink[];
}

// ---- Auth ----

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface CsrfResponse {
  csrfToken: string;
}

export interface SessionResponse {
  user?: SessionUser & Record<string, unknown>;
}

// ---- Lookups ----

export interface UserLookup {
  id: string;
  name: string;
}
