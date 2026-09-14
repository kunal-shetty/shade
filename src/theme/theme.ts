import { createContext, useContext } from 'react';
import { DarkTheme, DefaultTheme, type Theme as NavTheme } from '@react-navigation/native';
import type { TextStyle } from 'react-native';

export const palette = {
  primary: '#1A56DB',
  primaryDark: '#1E3A5F',
  accent: '#0EA5E9',
  threatLow: '#16A34A',
  threatMedium: '#D97706',
  threatHigh: '#EA580C',
  threatCritical: '#DC2626',
  surface: '#F1F5F9',
  bodyText: '#1E293B',
  mutedText: '#64748B',
  backgroundLight: '#FFFFFF',
  backgroundDark: '#0F172A',
  surfaceDark: '#1E293B',
  borderLight: '#E2E8F0',
  borderDark: '#334155',
  white: '#FFFFFF',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

const family = {
  regular: 'System',
  mono: 'monospace',
};

export const typography = {
  display: { fontFamily: family.regular, fontWeight: '700', fontSize: 32 } as TextStyle,
  h1: { fontFamily: family.regular, fontWeight: '700', fontSize: 24 } as TextStyle,
  h2: { fontFamily: family.regular, fontWeight: '600', fontSize: 20 } as TextStyle,
  bodyLg: { fontFamily: family.regular, fontWeight: '400', fontSize: 16 } as TextStyle,
  body: { fontFamily: family.regular, fontWeight: '400', fontSize: 14 } as TextStyle,
  caption: { fontFamily: family.regular, fontWeight: '400', fontSize: 12 } as TextStyle,
  mono: { fontFamily: family.mono, fontWeight: '400', fontSize: 12 } as TextStyle,
};

export interface ThemeColors {
  background: string;
  surface: string;
  card: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  accent: string;
  tabBar: string;
  shadow: string;
}

const lightColors: ThemeColors = {
  background: palette.backgroundLight,
  surface: palette.surface,
  card: palette.white,
  border: palette.borderLight,
  text: palette.bodyText,
  textMuted: palette.mutedText,
  primary: palette.primary,
  accent: palette.accent,
  tabBar: palette.white,
  shadow: 'rgba(30, 41, 59, 0.08)',
};

const darkColors: ThemeColors = {
  background: palette.backgroundDark,
  surface: palette.surfaceDark,
  card: palette.surfaceDark,
  border: palette.borderDark,
  text: '#E2E8F0',
  textMuted: '#94A3B8',
  primary: '#3B82F6',
  accent: palette.accent,
  tabBar: palette.surfaceDark,
  shadow: 'rgba(0, 0, 0, 0.45)',
};

export const navLight: NavTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: palette.primary, background: lightColors.background, card: lightColors.tabBar, text: lightColors.text, border: lightColors.border },
};

export const navDark: NavTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, primary: darkColors.primary, background: darkColors.background, card: darkColors.tabBar, text: darkColors.text, border: darkColors.border },
};

export const getThemeColors = (dark: boolean): ThemeColors => (dark ? darkColors : lightColors);

export const ThemeContext = createContext<ThemeColors>(lightColors);

export const useTheme = (): ThemeColors => useContext(ThemeContext);

export const threatColor = (level: ThreatLevelName): string =>
  ({ low: palette.threatLow, medium: palette.threatMedium, high: palette.threatHigh, critical: palette.threatCritical }[level]);

type ThreatLevelName = 'low' | 'medium' | 'high' | 'critical';
