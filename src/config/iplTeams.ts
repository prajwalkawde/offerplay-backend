export interface IplTeam {
  code: string;
  name: string;
  shortName: string;
  color: string;
  secondaryColor: string;
  logoUrl: string;
  emoji: string;
}

export const IPL_TEAMS: IplTeam[] = [
  {
    code: 'MI',
    name: 'Mumbai Indians',
    shortName: 'Mumbai',
    color: '#004BA0',
    secondaryColor: '#D4AC0D',
    logoUrl: '',
    emoji: '🔵',
  },
  {
    code: 'CSK',
    name: 'Chennai Super Kings',
    shortName: 'Chennai',
    color: '#FDB913',
    secondaryColor: '#0075BF',
    logoUrl: '',
    emoji: '🦁',
  },
  {
    code: 'RCB',
    name: 'Royal Challengers Bengaluru',
    shortName: 'Bengaluru',
    color: '#C8102E',
    secondaryColor: '#000000',
    logoUrl: '',
    emoji: '🔴',
  },
  {
    code: 'KKR',
    name: 'Kolkata Knight Riders',
    shortName: 'Kolkata',
    color: '#552683',
    secondaryColor: '#F4C300',
    logoUrl: '',
    emoji: '⚡',
  },
  {
    code: 'SRH',
    name: 'Sunrisers Hyderabad',
    shortName: 'Hyderabad',
    color: '#F26522',
    secondaryColor: '#000000',
    logoUrl: '',
    emoji: '🌅',
  },
  {
    code: 'DC',
    name: 'Delhi Capitals',
    shortName: 'Delhi',
    color: '#0078BC',
    secondaryColor: '#EF1C25',
    logoUrl: '',
    emoji: '🔷',
  },
  {
    code: 'PBKS',
    name: 'Punjab Kings',
    shortName: 'Punjab',
    color: '#AA4545',
    secondaryColor: '#DCDDDF',
    logoUrl: '',
    emoji: '👊',
  },
  {
    code: 'RR',
    name: 'Rajasthan Royals',
    shortName: 'Rajasthan',
    color: '#254AA5',
    secondaryColor: '#F0137A',
    logoUrl: '',
    emoji: '👑',
  },
  {
    code: 'GT',
    name: 'Gujarat Titans',
    shortName: 'Gujarat',
    color: '#1C1C6E',
    secondaryColor: '#B5862A',
    logoUrl: '',
    emoji: '🔱',
  },
  {
    code: 'LSG',
    name: 'Lucknow Super Giants',
    shortName: 'Lucknow',
    color: '#00C2E3',
    secondaryColor: '#A72056',
    logoUrl: '',
    emoji: '🦅',
  },
];

export const TEAM_BY_CODE: Record<string, IplTeam> = Object.fromEntries(
  IPL_TEAMS.map(t => [t.code, t])
);

/** Returns team data for a given code/name string (case-insensitive). */
export function getTeam(codeOrName: string): IplTeam | undefined {
  if (!codeOrName) return undefined;
  const upper = codeOrName.toUpperCase().trim();
  return IPL_TEAMS.find(
    t => t.code === upper || t.name.toUpperCase() === upper || t.shortName.toUpperCase() === upper
  );
}

/** Overrides logoUrl from DB settings (key = TEAM_LOGO_<CODE>). */
export function applyLogoOverrides(
  teams: IplTeam[],
  settings: Record<string, string>
): IplTeam[] {
  return teams.map(t => ({
    ...t,
    logoUrl: settings[`TEAM_LOGO_${t.code}`] || t.logoUrl,
  }));
}
