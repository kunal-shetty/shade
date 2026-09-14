import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { palette, spacing, typography, useTheme } from '../theme/theme';
import { useLiveData } from '../store/rover';
import { IncidentRow } from '../components/ui';
import { api } from '../services/api';
import type { Incident, Severity } from '../types';

const SEVERITY_FILTERS: (Severity | 'all')[] = ['all', 'critical', 'high', 'medium', 'low'];

export const IncidentsScreen = ({ navigation }: any) => {
  const c = useTheme();
  const incidents = useLiveData((s) => s.incidents);
  const setIncidents = useLiveData((s) => s.setIncidents);
  const markSeen = useLiveData((s) => s.markSeen);
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [hideResolved, setHideResolved] = useState(false);

  // Clear unread badge when user views the timeline (PRD §6.4.1)
  useEffect(() => {
    markSeen();
  }, [markSeen]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.listIncidents({ limit: 50 });
      setIncidents(list);
      setLoadError(false);
    } catch {
      setLoadError(true); // demo mode / offline: keep whatever we have
    }
  }, [setIncidents]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const filtered = incidents.filter(
    (i: Incident) => (severity === 'all' || i.severity === severity) && (!hideResolved || i.status === 'open'),
  );

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <View style={styles.header}>
        <Text style={[typography.h1, { color: c.text }]}>Incidents</Text>
        <Text
          onPress={() => setHideResolved((v) => !v)}
          style={[styles.resolveToggle, { color: hideResolved ? c.primary : c.textMuted }]}
          accessibilityRole="button"
          accessibilityLabel="Toggle hide resolved"
        >
          {hideResolved ? 'Showing open only' : 'Showing all'}
        </Text>
      </View>

      <View style={styles.filters}>
        {SEVERITY_FILTERS.map((s) => {
          const active = severity === s;
          return (
            <Text
              key={s}
              onPress={() => setSeverity(s)}
              style={[
                styles.chip,
                { backgroundColor: active ? c.primary : c.surface, color: active ? 'white' : c.text },
              ]}
              accessibilityRole="button"
              accessibilityLabel={'Filter ' + s}
            >
              {s.toUpperCase()}
            </Text>
          );
        })}
      </View>

      {loadError && incidents.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[typography.body, { color: c.textMuted }]}>
            No incident backend reachable.{'\n'}Enable Demo Mode in Settings to simulate incidents.
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(i) => String(i.id)}
          renderItem={({ item }) => (
            <IncidentRow incident={item} onPress={() => navigation.navigate('IncidentDetail', { id: item.id })} />
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={[typography.body, { color: c.textMuted }]}>No incidents match the current filters.</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  resolveToggle: { fontSize: 13, fontWeight: '700' },
  filters: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  chip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, fontSize: 11, fontWeight: '800', overflow: 'hidden' },
  list: { padding: spacing.lg, paddingTop: 0 },
  empty: { padding: spacing.xl, alignItems: 'center' },
});
