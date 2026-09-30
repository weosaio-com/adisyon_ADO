import type { MenuSnapshot } from '@ado/shared/menu';

// Panel API yanitlari (apps/cloud src/routes/panel.ts).
export interface BranchSummary {
  id: string;
  name: string;
  source: 'panel' | 'pos';
  pos: { pairedAt: string; lastSeenAt: string | null } | null;
  menu: { version: number; updatedAt: string } | null;
  tableCount: number;
}

export interface Me {
  user: { email: string };
  tenant: {
    name: string;
    plan: string;
    planLabel: string;
    status: 'active' | 'suspended';
    features: Record<string, boolean>;
  };
  branches: BranchSummary[];
}

export interface BranchMenu {
  source: 'panel' | 'pos';
  version: number | null;
  updatedAt: string | null;
  menu: MenuSnapshot | null;
}

export interface PanelTable {
  id: string;
  code: string;
  name: string;
  hall: string;
  sortOrder: number;
}
