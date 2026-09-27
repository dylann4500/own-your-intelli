using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityObject = UnityEngine.Object;

namespace QmEdge.Editor
{
    public sealed class UnityEdgeAdapter : IEdgeAdapter
    {
        public const string AdapterName = "unity";
        public const string GameObjectType = "GameObject";
        const string NameKey = "name";
        const string PrimitiveKey = "primitive";
        const string PositionKey = "position";
        const string RotationKey = "rotation";
        const string ScaleKey = "scale";
        const string LightIntensityKey = "light.intensity";
        const string LightColorKey = "light.color";
        const double ObserveInterval = 0.066;
        const double MinSendInterval = 0.06;
        const float PositionTolerance = 1e-4f;
        const float ScaleTolerance = 1e-4f;
        const float RotationTolerance = 1e-2f;
        const float LightTolerance = 1e-4f;
        const double MaxMagnitude = 1e9;
        const int MaxNameLength = 256;
        const int SuppressTicks = 2;
        const double SuppressSeconds = 0.25;
        const int IgnoreTicks = 3;
        const double IgnoreSeconds = 0.5;
        const int MaxRecentlyDeleted = 1024;
        static readonly string[] PrimitiveNames = { "Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad" };

        sealed class SyncedState
        {
            public string Name;
            public Vector3? Position;
            public Vector3? Rotation;
            public Vector3? Scale;
            public float? LightIntensity;
            public Color? LightColor;
            public double LastSentAt = double.NegativeInfinity;
        }

        sealed class OutgoingOperation
        {
            public string ResourceId;
            public string Action;
            public string Effect;
            public Dictionary<string, object> Payload;
            public string Label;
        }

        struct Suppression
        {
            public long UntilTick;
            public double UntilTime;
        }

        readonly Dictionary<string, GameObject> objectsById = new Dictionary<string, GameObject>();
        readonly Dictionary<int, string> idsByInstance = new Dictionary<int, string>();
        readonly Dictionary<string, Scene> scenesById = new Dictionary<string, Scene>();
        readonly HashSet<string> recentlyDeleted = new HashSet<string>();
        readonly Queue<string> recentlyDeletedOrder = new Queue<string>();
        readonly Dictionary<string, SyncedState> synced = new Dictionary<string, SyncedState>();
        readonly HashSet<int> dirty = new HashSet<int>();
        readonly Dictionary<int, Suppression> suppressed = new Dictionary<int, Suppression>();
        readonly Queue<OutgoingOperation> outgoing = new Queue<OutgoingOperation>();
        readonly Dictionary<string, int> queuedCounts = new Dictionary<string, int>();
        readonly List<GameObject> candidates = new List<GameObject>();
        readonly HashSet<int> candidateIds = new HashSet<int>();

        EdgeSession session;
        bool attached;
        bool repaintRequested;
        bool changedWhileDetached;
        long updateCount;
        long lastRebuildTick = -1;
        long ignoreUntilTick = -1;
        double ignoreUntilTime = double.NegativeInfinity;
        double lastObserveAt = double.NegativeInfinity;

        public string AdapterId
        {
            get { return AdapterName; }
        }

        public bool ChangedWhileDetached
        {
            get { return changedWhileDetached; }
        }

        public void Attach(EdgeSession owner)
        {
            session = owner;
            if (attached) return;
            attached = true;
            ObjectChangeEvents.changesPublished += OnChangesPublished;
            Selection.selectionChanged += UpdatePresence;
            EditorSceneManager.sceneOpened += OnSceneOpened;
            EditorSceneManager.newSceneCreated += OnNewSceneCreated;
            EditorSceneManager.sceneClosing += OnSceneClosing;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
        }

        public void Detach()
        {
            if (!attached) return;
            attached = false;
            ObjectChangeEvents.changesPublished -= OnChangesPublished;
            Selection.selectionChanged -= UpdatePresence;
            EditorSceneManager.sceneOpened -= OnSceneOpened;
            EditorSceneManager.newSceneCreated -= OnNewSceneCreated;
            EditorSceneManager.sceneClosing -= OnSceneClosing;
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
        }

        public void BeginSync()
        {
            changedWhileDetached = false;
            dirty.Clear();
            outgoing.Clear();
            queuedCounts.Clear();
            synced.Clear();
            objectsById.Clear();
            idsByInstance.Clear();
            scenesById.Clear();
            IndexLoadedScenes();
            foreach (KeyValuePair<string, GameObject> entry in objectsById) synced[entry.Key] = Capture(entry.Value);
            UpdatePresence();
        }

        public void Tick()
        {
            updateCount++;
            if (repaintRequested)
            {
                repaintRequested = false;
                UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
            }
            if (!CanObserve()) return;
            double now = EditorApplication.timeSinceStartup;
            if (now - lastObserveAt < ObserveInterval) return;
            lastObserveAt = now;
            PruneSuppressions(now);
            FlushOutgoing();
            Observe(now);
        }

        public void ApplyRemote(EdgeOperation operation, bool fromSnapshot)
        {
            if (operation == null || operation.ResourceType != GameObjectType || !EdgeText.IsValidId(operation.ResourceId)) return;
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            double now = EditorApplication.timeSinceStartup;
            Dictionary<string, object> payload = operation.Payload ?? new Dictionary<string, object>();
            switch (operation.Effect)
            {
                case EdgeEffect.Delete:
                    RemoteDelete(operation.ResourceId, now);
                    break;
                case EdgeEffect.Create:
                    RemoteCreate(operation.ResourceId, payload, operation.ResourceProperties, now);
                    break;
                case EdgeEffect.Update:
                {
                    GameObject target = Find(operation.ResourceId, false);
                    if (target != null) ApplyProperties(target, operation.ResourceId, payload, now);
                    break;
                }
            }
            repaintRequested = true;
        }

        public IEnumerable<EdgeAnnouncedResource> DescribeResources()
        {
            var resources = new List<EdgeAnnouncedResource>();
            foreach (KeyValuePair<string, GameObject> entry in objectsById)
            {
                if (entry.Value == null) continue;
                resources.Add(new EdgeAnnouncedResource
                {
                    ResourceType = GameObjectType,
                    ResourceId = entry.Key,
                    Properties = Describe(entry.Value)
                });
            }
            return resources;
        }

        public void OnOperationRejected(string resourceId, string effect, IList<string> keys)
        {
            if (!EdgeText.IsValidId(resourceId) || EditorApplication.isPlayingOrWillChangePlaymode) return;
            GameObject go = Find(resourceId, false);
            if (effect == EdgeEffect.Delete)
            {
                if (go != null) return;
                SyncedState deletedState;
                string deletedName = synced.TryGetValue(resourceId, out deletedState) && deletedState.Name != null ? deletedState.Name : resourceId;
                EnqueueDeferred(new OutgoingOperation
                {
                    ResourceId = resourceId,
                    Action = "delete_object",
                    Effect = EdgeEffect.Delete,
                    Payload = new Dictionary<string, object>(),
                    Label = "deleted " + deletedName
                });
                return;
            }
            if (go == null || !IsSyncable(go)) return;
            if (effect == EdgeEffect.Create)
            {
                SyncedState createdState = Capture(go);
                createdState.LastSentAt = EditorApplication.timeSinceStartup;
                synced[resourceId] = createdState;
                EnqueueDeferred(CreateOperation(resourceId, go));
                return;
            }
            SyncedState state;
            if (!synced.TryGetValue(resourceId, out state))
            {
                state = Capture(go);
                synced[resourceId] = state;
            }
            if (keys != null)
            {
                foreach (string key in keys)
                {
                    switch (key)
                    {
                        case NameKey: state.Name = null; break;
                        case PositionKey: state.Position = null; break;
                        case RotationKey: state.Rotation = null; break;
                        case ScaleKey: state.Scale = null; break;
                        case LightIntensityKey: state.LightIntensity = null; break;
                        case LightColorKey: state.LightColor = null; break;
                    }
                }
            }
            dirty.Add(go.GetInstanceID());
        }

        bool CanObserve()
        {
            return session != null && session.IsJoined && !EditorApplication.isPlayingOrWillChangePlaymode;
        }

        void OnChangesPublished(ref ObjectChangeEventStream stream)
        {
            double now = EditorApplication.timeSinceStartup;
            bool ignoring = updateCount <= ignoreUntilTick || now < ignoreUntilTime;
            if (!CanObserve())
            {
                if (!ignoring && stream.length > 0 && !EditorApplication.isPlayingOrWillChangePlaymode) changedWhileDetached = true;
                return;
            }
            bool sweep = false;
            for (int i = 0; i < stream.length; i++)
            {
                switch (stream.GetEventType(i))
                {
                    case ObjectChangeKind.CreateGameObjectHierarchy:
                    {
                        CreateGameObjectHierarchyEventArgs created;
                        stream.GetCreateGameObjectHierarchyEvent(i, out created);
                        if (!ignoring) OnLocalCreate(created.instanceId, now);
                        break;
                    }
                    case ObjectChangeKind.DestroyGameObjectHierarchy:
                    {
                        DestroyGameObjectHierarchyEventArgs destroyed;
                        stream.GetDestroyGameObjectHierarchyEvent(i, out destroyed);
                        OnLocalDestroy(destroyed.instanceId, destroyed.scene, ignoring, now);
                        sweep = true;
                        break;
                    }
                    case ObjectChangeKind.ChangeGameObjectStructureHierarchy:
                    {
                        ChangeGameObjectStructureHierarchyEventArgs hierarchy;
                        stream.GetChangeGameObjectStructureHierarchyEvent(i, out hierarchy);
                        if (!ignoring) MarkDirty(hierarchy.instanceId, now);
                        sweep = true;
                        break;
                    }
                    case ObjectChangeKind.ChangeGameObjectOrComponentProperties:
                    {
                        ChangeGameObjectOrComponentPropertiesEventArgs changed;
                        stream.GetChangeGameObjectOrComponentPropertiesEvent(i, out changed);
                        if (!ignoring) MarkDirty(changed.instanceId, now);
                        break;
                    }
                    case ObjectChangeKind.ChangeGameObjectStructure:
                    {
                        ChangeGameObjectStructureEventArgs structure;
                        stream.GetChangeGameObjectStructureEvent(i, out structure);
                        if (!ignoring) MarkDirty(structure.instanceId, now);
                        break;
                    }
                }
            }
            if (sweep) SweepDestroyed(ignoring, now);
        }

        void OnLocalCreate(int instanceId, double now)
        {
            GameObject go = EditorUtility.InstanceIDToObject(instanceId) as GameObject;
            if (!IsSyncable(go) || IsSuppressed(instanceId, now) || idsByInstance.ContainsKey(instanceId)) return;
            string resourceId = EnsureIdentity(go);
            Index(resourceId, go);
            SyncedState state = Capture(go);
            state.LastSentAt = now;
            synced[resourceId] = state;
            var operations = new List<OutgoingOperation> { CreateOperation(resourceId, go) };
            foreach (Transform child in go.GetComponentsInChildren<Transform>(true))
            {
                GameObject childObject = child.gameObject;
                if (childObject == go || !IsSyncable(childObject)) continue;
                QmEdgeIdentity childIdentity = childObject.GetComponent<QmEdgeIdentity>();
                if (childIdentity == null) continue;
                int childInstanceId = childObject.GetInstanceID();
                if (idsByInstance.ContainsKey(childInstanceId)) continue;
                if (CanKeepId(childIdentity.Id, childObject)) recentlyDeleted.Remove(childIdentity.Id);
                else AssignNewId(childIdentity);
                Index(childIdentity.Id, childObject);
                SyncedState childState = Capture(childObject);
                childState.LastSentAt = now;
                synced[childIdentity.Id] = childState;
                operations.Add(CreateOperation(childIdentity.Id, childObject));
            }
            foreach (OutgoingOperation operation in operations) Enqueue(operation);
            EditorSceneManager.MarkSceneDirty(go.scene);
            UpdatePresence();
        }

        OutgoingOperation CreateOperation(string resourceId, GameObject go)
        {
            string primitive = DetectPrimitive(go);
            string name = OutgoingName(go);
            return new OutgoingOperation
            {
                ResourceId = resourceId,
                Action = "create_object",
                Effect = EdgeEffect.Create,
                Payload = Describe(go),
                Label = primitive != null ? "created " + primitive + " " + name : "created " + name
            };
        }

        void OnLocalDestroy(int instanceId, Scene scene, bool ignoring, double now)
        {
            string resourceId;
            if (!idsByInstance.TryGetValue(instanceId, out resourceId)) return;
            idsByInstance.Remove(instanceId);
            GameObject current;
            if (objectsById.TryGetValue(resourceId, out current) && current != null) return;
            ForgetDestroyed(resourceId, ignoring || IsSuppressed(instanceId, now) || !scene.IsValid() || !scene.isLoaded);
        }

        void SweepDestroyed(bool ignoring, double now)
        {
            List<int> stale = null;
            foreach (KeyValuePair<int, string> entry in idsByInstance)
            {
                GameObject current;
                if (objectsById.TryGetValue(entry.Value, out current) && current != null && current.GetInstanceID() == entry.Key) continue;
                if (stale == null) stale = new List<int>();
                stale.Add(entry.Key);
            }
            if (stale == null) return;
            foreach (int instanceId in stale)
            {
                string resourceId = idsByInstance[instanceId];
                idsByInstance.Remove(instanceId);
                dirty.Remove(instanceId);
                GameObject current;
                if (!objectsById.TryGetValue(resourceId, out current) || current != null) continue;
                Scene scene;
                bool sceneLoaded = scenesById.TryGetValue(resourceId, out scene) && scene.IsValid() && scene.isLoaded;
                ForgetDestroyed(resourceId, ignoring || IsSuppressed(instanceId, now) || !sceneLoaded);
            }
        }

        void ForgetDestroyed(string resourceId, bool silent)
        {
            objectsById.Remove(resourceId);
            scenesById.Remove(resourceId);
            SyncedState state;
            string name = synced.TryGetValue(resourceId, out state) && state.Name != null ? state.Name : resourceId;
            synced.Remove(resourceId);
            if (silent) return;
            RememberDeleted(resourceId);
            Enqueue(new OutgoingOperation
            {
                ResourceId = resourceId,
                Action = "delete_object",
                Effect = EdgeEffect.Delete,
                Payload = new Dictionary<string, object>(),
                Label = "deleted " + name
            });
        }

        void RememberDeleted(string resourceId)
        {
            if (!recentlyDeleted.Add(resourceId)) return;
            recentlyDeletedOrder.Enqueue(resourceId);
            while (recentlyDeletedOrder.Count > MaxRecentlyDeleted) recentlyDeleted.Remove(recentlyDeletedOrder.Dequeue());
        }

        void MarkDirty(int instanceId, double now)
        {
            UnityObject changed = EditorUtility.InstanceIDToObject(instanceId);
            GameObject go = changed as GameObject;
            if (go == null)
            {
                Component component = changed as Component;
                if (component != null) go = component.gameObject;
            }
            if (go == null) return;
            int objectId = go.GetInstanceID();
            if (IsSuppressed(objectId, now) || !idsByInstance.ContainsKey(objectId)) return;
            dirty.Add(objectId);
        }

        void Observe(double now)
        {
            candidates.Clear();
            candidateIds.Clear();
            foreach (GameObject selected in Selection.gameObjects) AddCandidate(selected);
            if (dirty.Count > 0)
            {
                foreach (int instanceId in dirty) AddCandidate(EditorUtility.InstanceIDToObject(instanceId) as GameObject);
                dirty.Clear();
            }
            foreach (GameObject go in candidates)
            {
                if (!ObserveObject(go, now)) dirty.Add(go.GetInstanceID());
            }
            candidates.Clear();
        }

        void AddCandidate(GameObject go)
        {
            if (go == null) return;
            if (candidateIds.Add(go.GetInstanceID())) candidates.Add(go);
        }

        bool ObserveObject(GameObject go, double now)
        {
            if (!IsSyncable(go)) return true;
            int instanceId = go.GetInstanceID();
            string resourceId;
            if (!idsByInstance.TryGetValue(instanceId, out resourceId)) return true;
            if (IsSuppressed(instanceId, now) || queuedCounts.ContainsKey(resourceId)) return false;
            SyncedState state;
            if (!synced.TryGetValue(resourceId, out state))
            {
                synced[resourceId] = Capture(go);
                return true;
            }
            if (now - state.LastSentAt < MinSendInterval) return false;
            return SendChanges(go, resourceId, state, now);
        }

        bool SendChanges(GameObject go, string resourceId, SyncedState state, double now)
        {
            Transform transform = go.transform;
            Vector3 position = transform.position;
            Vector3 rotation = transform.eulerAngles;
            Vector3 scale = transform.localScale;
            string name = OutgoingName(go);
            bool moved = !Same(state.Position, position, PositionTolerance);
            bool rotated = !SameAngles(state.Rotation, rotation);
            bool scaled = !Same(state.Scale, scale, ScaleTolerance);
            if (moved || rotated || scaled)
            {
                var transformPayload = new Dictionary<string, object>();
                if (moved) transformPayload[PositionKey] = ToJson(position);
                if (rotated) transformPayload[RotationKey] = ToJson(rotation);
                if (scaled) transformPayload[ScaleKey] = ToJson(scale);
                string verb = moved ? "moved " : rotated ? "rotated " : "scaled ";
                if (!session.TrySubmit(GameObjectType, resourceId, "set_transform", EdgeEffect.Update, transformPayload, verb + name)) return false;
                if (moved) state.Position = position;
                if (rotated) state.Rotation = rotation;
                if (scaled) state.Scale = scale;
                state.LastSentAt = now;
            }
            if (state.Name != go.name)
            {
                var renamePayload = new Dictionary<string, object> { { NameKey, name } };
                string label = state.Name != null ? "renamed " + state.Name + " to " + name : "renamed " + name;
                if (!session.TrySubmit(GameObjectType, resourceId, "rename", EdgeEffect.Update, renamePayload, label)) return false;
                state.Name = go.name;
                state.LastSentAt = now;
            }
            Light light = go.GetComponent<Light>();
            if (light == null) return true;
            float intensity = light.intensity;
            Color color = light.color;
            bool intensityChanged = !state.LightIntensity.HasValue || !(Mathf.Abs(state.LightIntensity.Value - intensity) <= LightTolerance);
            bool colorChanged = !state.LightColor.HasValue || !SameColor(state.LightColor.Value, color);
            if (!intensityChanged && !colorChanged) return true;
            var lightPayload = new Dictionary<string, object>();
            if (intensityChanged) lightPayload[LightIntensityKey] = intensity;
            if (colorChanged) lightPayload[LightColorKey] = ToJson(color);
            string lightLabel = intensityChanged
                ? "changed " + name + " intensity to " + intensity.ToString("0.##", CultureInfo.InvariantCulture)
                : "changed " + name + " color";
            if (!session.TrySubmit(GameObjectType, resourceId, "set_property", EdgeEffect.Update, lightPayload, lightLabel)) return false;
            if (intensityChanged) state.LightIntensity = intensity;
            if (colorChanged) state.LightColor = color;
            state.LastSentAt = now;
            return true;
        }

        void RemoteCreate(string resourceId, Dictionary<string, object> payload, Dictionary<string, object> hints, double now)
        {
            GameObject go = Find(resourceId, true);
            if (go == null)
            {
                Dictionary<string, object> source = hints ?? payload;
                string name = EdgeText.Clean(ReadString(payload, NameKey) ?? ReadString(source, NameKey), MaxNameLength) ?? "GameObject";
                PrimitiveType primitive;
                bool isPrimitive = TryParsePrimitive(ReadString(payload, PrimitiveKey) ?? ReadString(source, PrimitiveKey), out primitive);
                go = isPrimitive ? GameObject.CreatePrimitive(primitive) : new GameObject(name);
                go.name = name;
                Suppress(go.GetInstanceID(), now);
                QmEdgeIdentity identity = go.AddComponent<QmEdgeIdentity>();
                identity.Id = resourceId;
                if (HasLightKeys(payload) || HasLightKeys(source)) go.AddComponent<Light>();
                Index(resourceId, go);
                synced[resourceId] = Capture(go);
                EditorSceneManager.MarkSceneDirty(go.scene);
            }
            ApplyProperties(go, resourceId, payload, now);
        }

        static string ReadString(Dictionary<string, object> map, string key)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value)) return null;
            return value as string;
        }

        static bool HasLightKeys(Dictionary<string, object> map)
        {
            return map != null && (map.ContainsKey(LightIntensityKey) || map.ContainsKey(LightColorKey));
        }

        void RemoteDelete(string resourceId, double now)
        {
            GameObject go = Find(resourceId, false);
            if (go == null)
            {
                objectsById.Remove(resourceId);
                scenesById.Remove(resourceId);
                synced.Remove(resourceId);
                return;
            }
            if (PrefabUtility.IsPartOfPrefabInstance(go) && !PrefabUtility.IsOutermostPrefabInstanceRoot(go))
            {
                Debug.LogWarning("[QM Edge] cannot delete " + go.name + " because it is inside a prefab instance; unpack the prefab to allow remote deletes");
                return;
            }
            foreach (Transform part in go.GetComponentsInChildren<Transform>(true))
            {
                int partId = part.gameObject.GetInstanceID();
                Suppress(partId, now);
                dirty.Remove(partId);
                string partResourceId;
                if (!idsByInstance.TryGetValue(partId, out partResourceId)) continue;
                idsByInstance.Remove(partId);
                objectsById.Remove(partResourceId);
                scenesById.Remove(partResourceId);
                synced.Remove(partResourceId);
            }
            Scene scene = go.scene;
            UnityObject.DestroyImmediate(go);
            if (scene.IsValid()) EditorSceneManager.MarkSceneDirty(scene);
        }

        void ApplyProperties(GameObject go, string resourceId, Dictionary<string, object> payload, double now)
        {
            if (payload.Count == 0) return;
            Suppress(go.GetInstanceID(), now);
            SyncedState state;
            if (!synced.TryGetValue(resourceId, out state))
            {
                state = Capture(go);
                synced[resourceId] = state;
            }
            Transform transform = go.transform;
            Light light = go.GetComponent<Light>();
            Transform[] descendants = null;
            Vector3[] descendantPositions = null;
            Vector3[] descendantRotations = null;
            if (transform.childCount > 0 && (payload.ContainsKey(PositionKey) || payload.ContainsKey(RotationKey) || payload.ContainsKey(ScaleKey)))
            {
                descendants = go.GetComponentsInChildren<Transform>(true);
                descendantPositions = new Vector3[descendants.Length];
                descendantRotations = new Vector3[descendants.Length];
                for (int i = 0; i < descendants.Length; i++)
                {
                    descendantPositions[i] = descendants[i].position;
                    descendantRotations[i] = descendants[i].eulerAngles;
                }
            }
            bool objectChanged = false;
            bool transformChanged = false;
            bool lightChanged = false;
            foreach (KeyValuePair<string, object> entry in payload)
            {
                Vector3 vector;
                float number;
                Color color;
                switch (entry.Key)
                {
                    case NameKey:
                    {
                        string name = EdgeText.Clean(entry.Value as string, MaxNameLength);
                        if (name == null) break;
                        go.name = name;
                        state.Name = go.name;
                        objectChanged = true;
                        break;
                    }
                    case PositionKey:
                        if (!TryReadVector3(entry.Value, out vector)) break;
                        transform.position = vector;
                        state.Position = transform.position;
                        transformChanged = true;
                        break;
                    case RotationKey:
                        if (!TryReadVector3(entry.Value, out vector)) break;
                        transform.eulerAngles = vector;
                        state.Rotation = transform.eulerAngles;
                        transformChanged = true;
                        break;
                    case ScaleKey:
                        if (!TryReadVector3(entry.Value, out vector)) break;
                        transform.localScale = vector;
                        state.Scale = transform.localScale;
                        transformChanged = true;
                        break;
                    case LightIntensityKey:
                        if (light == null || !TryReadFloat(entry.Value, out number)) break;
                        light.intensity = Mathf.Max(0f, number);
                        state.LightIntensity = light.intensity;
                        lightChanged = true;
                        break;
                    case LightColorKey:
                        if (light == null || !TryReadColor(entry.Value, out color)) break;
                        light.color = color;
                        state.LightColor = light.color;
                        lightChanged = true;
                        break;
                }
            }
            if (!objectChanged && !transformChanged && !lightChanged) return;
            if (transformChanged && descendants != null) RefreshDescendants(transform, descendants, descendantPositions, descendantRotations);
            if (PrefabUtility.IsPartOfPrefabInstance(go))
            {
                if (objectChanged) PrefabUtility.RecordPrefabInstancePropertyModifications(go);
                if (transformChanged) PrefabUtility.RecordPrefabInstancePropertyModifications(transform);
                if (lightChanged) PrefabUtility.RecordPrefabInstancePropertyModifications(light);
            }
            EditorSceneManager.MarkSceneDirty(go.scene);
        }

        void RefreshDescendants(Transform root, Transform[] descendants, Vector3[] positionsBefore, Vector3[] rotationsBefore)
        {
            for (int i = 0; i < descendants.Length; i++)
            {
                Transform part = descendants[i];
                if (part == null || part == root) continue;
                string partResourceId;
                if (!idsByInstance.TryGetValue(part.gameObject.GetInstanceID(), out partResourceId)) continue;
                SyncedState partState;
                if (!synced.TryGetValue(partResourceId, out partState)) continue;
                if (Same(partState.Position, positionsBefore[i], PositionTolerance)) partState.Position = part.position;
                if (SameAngles(partState.Rotation, rotationsBefore[i])) partState.Rotation = part.eulerAngles;
            }
        }

        GameObject Find(string resourceId, bool allowRescan)
        {
            GameObject go;
            if (objectsById.TryGetValue(resourceId, out go) && go != null) return go;
            go = ResolveGlobalObjectId(resourceId);
            if (go != null && IsSyncable(go) && StableId(go) == resourceId)
            {
                Index(resourceId, go);
                if (!synced.ContainsKey(resourceId)) synced[resourceId] = Capture(go);
                return go;
            }
            if (!allowRescan || lastRebuildTick == updateCount) return null;
            IndexLoadedScenes();
            if (!objectsById.TryGetValue(resourceId, out go) || go == null) return null;
            if (!synced.ContainsKey(resourceId)) synced[resourceId] = Capture(go);
            return go;
        }

        void IndexLoadedScenes()
        {
            lastRebuildTick = updateCount;
            var withoutIdentity = new List<GameObject>();
            for (int sceneIndex = 0; sceneIndex < SceneManager.sceneCount; sceneIndex++)
            {
                Scene scene = SceneManager.GetSceneAt(sceneIndex);
                if (!scene.IsValid() || !scene.isLoaded) continue;
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    foreach (Transform part in root.GetComponentsInChildren<Transform>(true))
                    {
                        GameObject go = part.gameObject;
                        if (!IsSyncable(go)) continue;
                        QmEdgeIdentity identity = go.GetComponent<QmEdgeIdentity>();
                        if (identity == null)
                        {
                            withoutIdentity.Add(go);
                            continue;
                        }
                        if (!EdgeText.IsValidId(identity.Id) || IsHeldByOther(identity.Id, go)) AssignNewId(identity);
                        Index(identity.Id, go);
                    }
                }
            }
            if (withoutIdentity.Count == 0) return;
            UnityObject[] objects = withoutIdentity.ToArray();
            var globalIds = new GlobalObjectId[objects.Length];
            GlobalObjectId.GetGlobalObjectIdsSlow(objects, globalIds);
            for (int i = 0; i < globalIds.Length; i++)
            {
                if (!IsStable(globalIds[i])) continue;
                string id = globalIds[i].ToString();
                if (IsHeldByOther(id, withoutIdentity[i])) continue;
                Index(id, withoutIdentity[i]);
            }
        }

        void Index(string resourceId, GameObject go)
        {
            objectsById[resourceId] = go;
            idsByInstance[go.GetInstanceID()] = resourceId;
            scenesById[resourceId] = go.scene;
        }

        bool IsHeldByOther(string resourceId, GameObject go)
        {
            GameObject existing;
            return objectsById.TryGetValue(resourceId, out existing) && existing != null && existing != go;
        }

        string EnsureIdentity(GameObject go)
        {
            QmEdgeIdentity identity = go.GetComponent<QmEdgeIdentity>();
            if (identity == null)
            {
                identity = go.AddComponent<QmEdgeIdentity>();
                AssignNewId(identity);
                return identity.Id;
            }
            if (CanKeepId(identity.Id, go)) recentlyDeleted.Remove(identity.Id);
            else AssignNewId(identity);
            return identity.Id;
        }

        bool CanKeepId(string resourceId, GameObject go)
        {
            return EdgeText.IsValidId(resourceId) && recentlyDeleted.Contains(resourceId) && !IsHeldByOther(resourceId, go);
        }

        static void AssignNewId(QmEdgeIdentity identity)
        {
            identity.Id = Guid.NewGuid().ToString();
            if (PrefabUtility.IsPartOfPrefabInstance(identity)) PrefabUtility.RecordPrefabInstancePropertyModifications(identity);
            Scene scene = identity.gameObject.scene;
            if (scene.IsValid()) EditorSceneManager.MarkSceneDirty(scene);
        }

        static string StableId(GameObject go)
        {
            QmEdgeIdentity identity = go.GetComponent<QmEdgeIdentity>();
            if (identity != null) return EdgeText.IsValidId(identity.Id) ? identity.Id : null;
            GlobalObjectId globalId = GlobalObjectId.GetGlobalObjectIdSlow(go);
            return IsStable(globalId) ? globalId.ToString() : null;
        }

        static bool IsStable(GlobalObjectId globalId)
        {
            return globalId.identifierType == 2 && globalId.targetObjectId != 0 && !globalId.assetGUID.Empty();
        }

        static GameObject ResolveGlobalObjectId(string resourceId)
        {
            if (!resourceId.StartsWith("GlobalObjectId", StringComparison.Ordinal)) return null;
            GlobalObjectId globalId;
            if (!GlobalObjectId.TryParse(resourceId, out globalId) || !IsStable(globalId)) return null;
            return GlobalObjectId.GlobalObjectIdentifierToObjectSlow(globalId) as GameObject;
        }

        static bool IsSyncable(GameObject go)
        {
            if (go == null || EditorUtility.IsPersistent(go)) return false;
            if ((go.hideFlags & (HideFlags.HideInHierarchy | HideFlags.DontSaveInEditor)) != 0) return false;
            Scene scene = go.scene;
            return scene.IsValid() && scene.isLoaded && !EditorSceneManager.IsPreviewScene(scene);
        }

        void Enqueue(OutgoingOperation operation)
        {
            EnqueueDeferred(operation);
            FlushOutgoing();
        }

        void EnqueueDeferred(OutgoingOperation operation)
        {
            outgoing.Enqueue(operation);
            int count;
            queuedCounts.TryGetValue(operation.ResourceId, out count);
            queuedCounts[operation.ResourceId] = count + 1;
        }

        void FlushOutgoing()
        {
            while (outgoing.Count > 0)
            {
                OutgoingOperation next = outgoing.Peek();
                if (!session.TrySubmit(GameObjectType, next.ResourceId, next.Action, next.Effect, next.Payload, next.Label)) return;
                outgoing.Dequeue();
                int count;
                if (!queuedCounts.TryGetValue(next.ResourceId, out count)) continue;
                if (count <= 1) queuedCounts.Remove(next.ResourceId);
                else queuedCounts[next.ResourceId] = count - 1;
            }
        }

        void UpdatePresence()
        {
            if (!CanObserve()) return;
            GameObject go = Selection.activeGameObject;
            string resourceId;
            if (go != null && IsSyncable(go) && idsByInstance.TryGetValue(go.GetInstanceID(), out resourceId))
            {
                session.SetWorkingOn(GameObjectType, resourceId, go.name);
                return;
            }
            session.SetWorkingOn(null, null, null);
        }

        void OnSceneOpened(Scene scene, OpenSceneMode mode)
        {
            IgnoreEventsBriefly();
            if (session != null) session.RequestResync();
        }

        void OnNewSceneCreated(Scene scene, NewSceneSetup setup, NewSceneMode mode)
        {
            IgnoreEventsBriefly();
            if (session != null) session.RequestResync();
        }

        void OnSceneClosing(Scene scene, bool removingScene)
        {
            IgnoreEventsBriefly();
            var closing = new HashSet<string>();
            foreach (KeyValuePair<string, Scene> entry in scenesById)
            {
                if (entry.Value == scene) closing.Add(entry.Key);
            }
            if (closing.Count == 0) return;
            var instances = new List<int>();
            foreach (KeyValuePair<int, string> entry in idsByInstance)
            {
                if (closing.Contains(entry.Value)) instances.Add(entry.Key);
            }
            foreach (int instanceId in instances)
            {
                idsByInstance.Remove(instanceId);
                dirty.Remove(instanceId);
            }
            foreach (string resourceId in closing)
            {
                objectsById.Remove(resourceId);
                scenesById.Remove(resourceId);
                synced.Remove(resourceId);
            }
        }

        void OnPlayModeStateChanged(PlayModeStateChange change)
        {
            IgnoreEventsBriefly();
            dirty.Clear();
        }

        void IgnoreEventsBriefly()
        {
            ignoreUntilTick = updateCount + IgnoreTicks;
            ignoreUntilTime = EditorApplication.timeSinceStartup + IgnoreSeconds;
        }

        void Suppress(int instanceId, double now)
        {
            suppressed[instanceId] = new Suppression { UntilTick = updateCount + SuppressTicks, UntilTime = now + SuppressSeconds };
        }

        bool IsSuppressed(int instanceId, double now)
        {
            Suppression suppression;
            if (!suppressed.TryGetValue(instanceId, out suppression)) return false;
            return updateCount <= suppression.UntilTick || now < suppression.UntilTime;
        }

        void PruneSuppressions(double now)
        {
            if (suppressed.Count == 0) return;
            List<int> expired = null;
            foreach (KeyValuePair<int, Suppression> entry in suppressed)
            {
                if (updateCount <= entry.Value.UntilTick || now < entry.Value.UntilTime) continue;
                if (expired == null) expired = new List<int>();
                expired.Add(entry.Key);
            }
            if (expired == null) return;
            foreach (int instanceId in expired) suppressed.Remove(instanceId);
        }

        static SyncedState Capture(GameObject go)
        {
            Transform transform = go.transform;
            var state = new SyncedState
            {
                Name = go.name,
                Position = transform.position,
                Rotation = transform.eulerAngles,
                Scale = transform.localScale
            };
            Light light = go.GetComponent<Light>();
            if (light != null)
            {
                state.LightIntensity = light.intensity;
                state.LightColor = light.color;
            }
            return state;
        }

        static Dictionary<string, object> Describe(GameObject go)
        {
            Transform transform = go.transform;
            var properties = new Dictionary<string, object>
            {
                { NameKey, OutgoingName(go) },
                { PositionKey, ToJson(transform.position) },
                { RotationKey, ToJson(transform.eulerAngles) },
                { ScaleKey, ToJson(transform.localScale) }
            };
            string primitive = DetectPrimitive(go);
            if (primitive != null) properties[PrimitiveKey] = primitive;
            Light light = go.GetComponent<Light>();
            if (light != null)
            {
                properties[LightIntensityKey] = light.intensity;
                properties[LightColorKey] = ToJson(light.color);
            }
            return properties;
        }

        static string OutgoingName(GameObject go)
        {
            return EdgeText.Clean(go.name, MaxNameLength) ?? "GameObject";
        }

        static string DetectPrimitive(GameObject go)
        {
            MeshFilter filter = go.GetComponent<MeshFilter>();
            if (filter == null || filter.sharedMesh == null) return null;
            string meshName = filter.sharedMesh.name;
            foreach (string candidate in PrimitiveNames)
            {
                if (meshName == candidate) return candidate;
            }
            return null;
        }

        static bool TryParsePrimitive(string value, out PrimitiveType primitive)
        {
            switch (value)
            {
                case "Cube": primitive = PrimitiveType.Cube; return true;
                case "Sphere": primitive = PrimitiveType.Sphere; return true;
                case "Capsule": primitive = PrimitiveType.Capsule; return true;
                case "Cylinder": primitive = PrimitiveType.Cylinder; return true;
                case "Plane": primitive = PrimitiveType.Plane; return true;
                case "Quad": primitive = PrimitiveType.Quad; return true;
                default: primitive = PrimitiveType.Cube; return false;
            }
        }

        static List<object> ToJson(Vector3 value)
        {
            return new List<object> { value.x, value.y, value.z };
        }

        static List<object> ToJson(Color value)
        {
            return new List<object> { value.r, value.g, value.b, value.a };
        }

        static bool TryReadFloat(object value, out float result)
        {
            result = 0f;
            double number;
            if (!Json.TryGetNumber(value, out number)) return false;
            if (double.IsNaN(number) || double.IsInfinity(number) || Math.Abs(number) > MaxMagnitude) return false;
            result = (float)number;
            return true;
        }

        static bool TryReadVector3(object value, out Vector3 vector)
        {
            vector = Vector3.zero;
            List<object> items = value as List<object>;
            if (items == null || items.Count != 3) return false;
            float x;
            float y;
            float z;
            if (!TryReadFloat(items[0], out x) || !TryReadFloat(items[1], out y) || !TryReadFloat(items[2], out z)) return false;
            vector = new Vector3(x, y, z);
            return true;
        }

        static bool TryReadColor(object value, out Color color)
        {
            color = Color.white;
            List<object> items = value as List<object>;
            if (items == null || (items.Count != 3 && items.Count != 4)) return false;
            float r;
            float g;
            float b;
            float a = 1f;
            if (!TryReadFloat(items[0], out r) || !TryReadFloat(items[1], out g) || !TryReadFloat(items[2], out b)) return false;
            if (items.Count == 4 && !TryReadFloat(items[3], out a)) return false;
            color = new Color(r, g, b, a);
            return true;
        }

        static bool Same(Vector3? cached, Vector3 current, float tolerance)
        {
            if (!cached.HasValue) return false;
            Vector3 value = cached.Value;
            return Mathf.Abs(value.x - current.x) <= tolerance && Mathf.Abs(value.y - current.y) <= tolerance && Mathf.Abs(value.z - current.z) <= tolerance;
        }

        static bool SameAngles(Vector3? cached, Vector3 current)
        {
            if (!cached.HasValue) return false;
            Vector3 value = cached.Value;
            return Mathf.Abs(Mathf.DeltaAngle(value.x, current.x)) <= RotationTolerance
                && Mathf.Abs(Mathf.DeltaAngle(value.y, current.y)) <= RotationTolerance
                && Mathf.Abs(Mathf.DeltaAngle(value.z, current.z)) <= RotationTolerance;
        }

        static bool SameColor(Color cached, Color current)
        {
            return Mathf.Abs(cached.r - current.r) <= LightTolerance
                && Mathf.Abs(cached.g - current.g) <= LightTolerance
                && Mathf.Abs(cached.b - current.b) <= LightTolerance
                && Mathf.Abs(cached.a - current.a) <= LightTolerance;
        }
    }
}
