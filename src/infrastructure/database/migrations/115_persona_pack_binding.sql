-- Register the identity-free Jeb pack + operator binding snapshot.
INSERT INTO persona_versions (
  persona_id, version, manifest_hash, profile_json, capability_json,
  tag_json, corpus_namespace, status, reviewed_at
) VALUES (
  'jeb',
  '1.1.0',
  'ff500c2bb86cfab737a3b79c7b832a41b56a074ada78a1aec0e5ddc13b9809f1',
  '{"name":"Jeb","bio":"AI role operated by Synonym; not a person or authority. Sources and policy are linked below.","status":"automated","disclosure_kind":"role"}'::jsonb,
  '{"allow":["nexus_read","scout_graph","knowledge_global","web_search","image_read","tags","translate","evidence_map"]}'::jsonb,
  '{"reply_vocabulary":["answer","pubky","bitkit","paykit","graph","evidence-map","summary","declined"],"artifact_vocabulary":["sources-cited","debate","release-notes"],"max_per_target":5}'::jsonb,
  'persona/jeb/1.1.0',
  'active',
  now()
)
ON CONFLICT (persona_id, version) DO NOTHING;

UPDATE personas
SET current_version = '1.1.0',
    manifest_hash = 'ff500c2bb86cfab737a3b79c7b832a41b56a074ada78a1aec0e5ddc13b9809f1',
    updated_at = now()
WHERE id = 'jeb';
