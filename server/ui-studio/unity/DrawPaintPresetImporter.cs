using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace DrawPaint.Generated.Editor
{
    public static class DrawPaintPresetImporter
    {
        [Serializable] private sealed class Preset { public string schema, name; public int width, height; public Node root; }
        [Serializable] private sealed class Node
        {
            public string name, layerType, sprite, text, fontFamily, textColor, textAlign, textRender;
            public float x, y, w, h, fontSize;
            public int imageWidth, imageHeight;
            public bool hidden;
            public float opacity = 1f;
            public Node[] children;
        }

        [MenuItem("Assets/DrawPaint/Build UI Prefab", true)]
        private static bool Validate() => Path.GetFileName(AssetDatabase.GetAssetPath(Selection.activeObject)) == "preset.json";

        [MenuItem("Assets/DrawPaint/Build UI Prefab")]
        private static void Build()
        {
            string jsonPath = AssetDatabase.GetAssetPath(Selection.activeObject);
            var preset = JsonUtility.FromJson<Preset>(File.ReadAllText(jsonPath));
            if (preset == null || preset.schema != "drawpaint.ui-preset.v1" || preset.root == null) throw new InvalidDataException("Invalid DrawPaint preset");
            string folder = Path.GetDirectoryName(jsonPath).Replace('\\', '/');
            GameObject root = null;
            try
            {
                root = Create(preset.root, null, folder);
                var rect = (RectTransform)root.transform;
                rect.anchorMin = rect.anchorMax = new Vector2(.5f, .5f);
                rect.pivot = new Vector2(.5f, .5f); rect.anchoredPosition = Vector2.zero;
                string target = AssetDatabase.GenerateUniqueAssetPath(folder + "/UI-Preset.prefab");
                PrefabUtility.SaveAsPrefabAsset(root, target, out bool success);
                if (!success) throw new IOException("Prefab save failed");
                Selection.activeObject = AssetDatabase.LoadAssetAtPath<GameObject>(target);
                Debug.Log("DrawPaint UI prefab saved: " + target + ". Place under an existing Canvas with GraphicRaycaster and EventSystem for interaction.");
            }
            finally { if (root != null) UnityEngine.Object.DestroyImmediate(root); }
        }

        private static GameObject Create(Node node, Transform parent, string folder)
        {
            var go = new GameObject(node.name, typeof(RectTransform), typeof(DrawPaintUIElement));
            try
            {
            go.transform.SetParent(parent, false);
            var rect = (RectTransform)go.transform;
            rect.anchorMin = rect.anchorMax = rect.pivot = new Vector2(0, 1);
            rect.anchoredPosition = new Vector2(node.x, -node.y);
            rect.sizeDelta = new Vector2(node.w, node.h);
            go.SetActive(!node.hidden);
            if (node.opacity < 1f) go.AddComponent<CanvasGroup>().alpha = node.opacity;
            var metadata = go.GetComponent<DrawPaintUIElement>();
            metadata.componentType = node.layerType; metadata.text = node.text;
            metadata.fontFamily = node.fontFamily; metadata.fontSize = node.fontSize; metadata.textRender = node.textRender;
            UnityEngine.UI.Image image = null;
            if (!string.IsNullOrEmpty(node.sprite))
            {
                string spritePath = (folder + "/" + node.sprite).Replace('\\', '/');
                var importer = AssetImporter.GetAtPath(spritePath) as TextureImporter;
                if (importer == null) throw new FileNotFoundException(spritePath);
                importer.textureType = TextureImporterType.Sprite; importer.spriteImportMode = SpriteImportMode.Single;
                importer.alphaIsTransparency = true; importer.mipmapEnabled = false; importer.textureCompression = TextureImporterCompression.Uncompressed;
                if (node.imageWidth > 0 && node.imageHeight > 0)
                    importer.maxTextureSize = Mathf.Clamp(Mathf.NextPowerOfTwo(Mathf.Max(node.imageWidth, node.imageHeight)), 32, 16384);
                importer.SaveAndReimport();
                image = go.AddComponent<UnityEngine.UI.Image>();
                image.sprite = AssetDatabase.LoadAssetAtPath<Sprite>(spritePath);
                image.raycastTarget = node.layerType == "button";
            }
            if (node.layerType == "button")
            {
                if (image == null) { image = go.AddComponent<UnityEngine.UI.Image>(); image.color = Color.clear; image.raycastTarget = true; }
                go.AddComponent<UnityEngine.UI.Button>().targetGraphic = image;
            }
            if (node.layerType == "text" && node.textRender == "editable") AddText(go, node, image);
            foreach (var child in node.children ?? Array.Empty<Node>()) Create(child, go.transform, folder);
            return go;
            }
            catch { UnityEngine.Object.DestroyImmediate(go); throw; }
        }

        private static void AddText(GameObject go, Node node, UnityEngine.UI.Image image)
        {
            // Reflection keeps raster-only packages importable without a TMP dependency.
            var tmpType = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TMPro.TextMeshProUGUI")).FirstOrDefault(t => t != null);
            if (tmpType == null || string.IsNullOrEmpty(node.text)) { Debug.LogWarning("TMP or text unavailable; retaining raster: " + node.name); return; }
            UnityEngine.Object font = null;
            if (!string.IsNullOrWhiteSpace(node.fontFamily))
                foreach (var guid in AssetDatabase.FindAssets("t:TMP_FontAsset"))
                {
                    var candidate = AssetDatabase.LoadMainAssetAtPath(AssetDatabase.GUIDToAssetPath(guid));
                    if (candidate != null && candidate.name == node.fontFamily) { font = candidate; break; }
                }
            if (font == null) { Debug.LogWarning("Set fontFamily to an existing TMP_FontAsset name; retaining raster: " + node.name); return; }
            var textObject = new GameObject("EditableText", typeof(RectTransform)); textObject.transform.SetParent(go.transform, false);
            var rect = (RectTransform)textObject.transform; rect.anchorMin = Vector2.zero; rect.anchorMax = Vector2.one; rect.offsetMin = rect.offsetMax = Vector2.zero;
            var component = textObject.AddComponent(tmpType);
            tmpType.GetProperty("font").SetValue(component, font);
            tmpType.GetProperty("text").SetValue(component, node.text);
            tmpType.GetProperty("fontSize").SetValue(component, node.fontSize > 0 ? node.fontSize : 24f);
            var alignment = tmpType.GetProperty("alignment");
            alignment.SetValue(component, Enum.Parse(alignment.PropertyType, node.textAlign == "left" ? "MidlineLeft" : node.textAlign == "right" ? "MidlineRight" : "Center"));
            if (ColorUtility.TryParseHtmlString(node.textColor, out var color)) tmpType.GetProperty("color").SetValue(component, color);
            tmpType.GetProperty("raycastTarget").SetValue(component, false);
            if (image != null) image.enabled = false;
        }
    }
}
