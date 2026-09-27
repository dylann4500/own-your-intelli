using System;
using System.Globalization;
using UnityEditor;
using UnityEngine;

namespace QmEdge.Editor
{
    public static class EdgePrefs
    {
        public const string DefaultHubUrl = "ws://127.0.0.1:8787/edge/ws";
        public const string DefaultProjectId = "unity-demo";
        const string HubUrlKey = "QmEdge.HubUrl";
        const string ProjectIdKey = "QmEdge.ProjectId";
        const string DisplayNameKey = "QmEdge.DisplayName";
        const string ActorIdKey = "QmEdge.ActorId";
        const string TokenKey = "QmEdge.Token";
        const string AutoConnectKey = "QmEdge.AutoConnect";
        const string NodeIdKeyPrefix = "QmEdge.NodeId.";

        public static string HubUrl
        {
            get { return EditorPrefs.GetString(HubUrlKey, DefaultHubUrl); }
            set { EditorPrefs.SetString(HubUrlKey, value ?? ""); }
        }

        public static string ProjectId
        {
            get { return EditorPrefs.GetString(ProjectIdKey, DefaultProjectId); }
            set { EditorPrefs.SetString(ProjectIdKey, value ?? ""); }
        }

        public static string DisplayName
        {
            get { return EditorPrefs.GetString(DisplayNameKey, SystemUserName() ?? "Unity User"); }
            set { EditorPrefs.SetString(DisplayNameKey, value ?? ""); }
        }

        public static string ActorId
        {
            get
            {
                string value = EditorPrefs.GetString(ActorIdKey, "");
                if (string.IsNullOrWhiteSpace(value))
                {
                    value = Guid.NewGuid().ToString();
                    EditorPrefs.SetString(ActorIdKey, value);
                }
                return value;
            }
            set { EditorPrefs.SetString(ActorIdKey, value ?? ""); }
        }

        public static string Token
        {
            get { return EditorPrefs.GetString(TokenKey, ""); }
            set { EditorPrefs.SetString(TokenKey, value ?? ""); }
        }

        public static bool AutoConnect
        {
            get { return EditorPrefs.GetBool(AutoConnectKey, false); }
            set { EditorPrefs.SetBool(AutoConnectKey, value); }
        }

        public static EdgeSettings Load()
        {
            string projectId = (ProjectId ?? "").Trim();
            return new EdgeSettings
            {
                HubUrl = (HubUrl ?? "").Trim(),
                ProjectId = projectId,
                DisplayName = EdgeText.Clean(DisplayName, 80) ?? EdgeText.Clean(SystemUserName(), 80) ?? "Unity User",
                ActorId = EdgeText.Clean(ActorId, EdgeText.MaxIdLength),
                Token = Token ?? "",
                NodeId = NodeIdFor(projectId),
                DeviceName = EdgeText.Clean(SystemInfo.deviceName, 80)
            };
        }

        public static string NodeIdFor(string projectId)
        {
            string key = NodeIdKeyPrefix + StableHash(Application.dataPath + "|" + (projectId ?? ""));
            string value = EditorPrefs.GetString(key, "");
            if (!EdgeText.IsValidId(value))
            {
                value = "unity-" + Guid.NewGuid().ToString("N");
                EditorPrefs.SetString(key, value);
            }
            return value;
        }

        static string SystemUserName()
        {
            try
            {
                return EdgeText.Clean(Environment.UserName, 80);
            }
            catch (Exception)
            {
                return null;
            }
        }

        static string StableHash(string value)
        {
            ulong hash = 14695981039346656037UL;
            foreach (char c in value)
            {
                hash ^= c;
                hash *= 1099511628211UL;
            }
            return hash.ToString("x16", CultureInfo.InvariantCulture);
        }
    }

    [InitializeOnLoad]
    public static class EdgeBootstrap
    {
        static readonly UnityEdgeAdapter adapter;
        static readonly EdgeSession session;

        static EdgeBootstrap()
        {
            adapter = new UnityEdgeAdapter();
            session = new EdgeSession(adapter);
            EditorApplication.update += session.Update;
            AssemblyReloadEvents.beforeAssemblyReload += Shutdown;
            EditorApplication.quitting += Shutdown;
            if (!Application.isBatchMode && EdgePrefs.AutoConnect) EditorApplication.delayCall += Resume;
        }

        public static EdgeSession Session
        {
            get { return session; }
        }

        public static UnityEdgeAdapter Adapter
        {
            get { return adapter; }
        }

        static void Resume()
        {
            if (EdgePrefs.AutoConnect && !session.WantsConnection) session.Connect();
        }

        static void Shutdown()
        {
            EditorApplication.update -= session.Update;
            session.Shutdown();
        }
    }
}
