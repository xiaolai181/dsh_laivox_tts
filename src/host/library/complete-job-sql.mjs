// Newest finished generate job at any revision: the plan is closed and every
// part has audio. Shared by latestCompleteAudioJob and stale-audio cleanup so
// the two cannot drift.
export const completeAudioJobWhere = `j.chapter=? AND json_extract(j.spec,'$.purpose')='generate'
  AND j.state<>'cancelled' AND json_extract(j.progress,'$.partsOpen') IS NOT 1
  AND json_array_length(j.progress,'$.parts')>0
  AND NOT EXISTS (SELECT 1 FROM json_each(j.progress,'$.parts') p
    WHERE NOT EXISTS (SELECT 1 FROM audio a WHERE a.chapter=j.chapter AND a.key=json_extract(p.value,'$.key')))`

export const latestCompleteAudioJobSQL = `SELECT j.* FROM jobs j WHERE ${completeAudioJobWhere}
  ORDER BY j.created DESC,j.rowid DESC LIMIT 1`
