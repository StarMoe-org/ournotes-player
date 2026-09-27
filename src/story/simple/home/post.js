import { URPPost, VOLUME_DEFAULTS, VOLUME_PARAMS } from "../../../engine/postfx.js";

// The main camera of the home spot as it renders a talk (CameraManager.MainCamera, a Fwk.Cam.UniversalCamera), and the
// volume stack it post-processes the spot with.
//   - camera: SpotSceneRoot.Setup -> SceneRoot.OnCameraSetup: MainCamera.SetCameraInfo(_sceneCamera) copies the Spot
//     scene camera's position, rotation, projection, clear flags, background colour, clip planes and culling mask, then
//     the scene camera is deactivated. What SetCameraInfo does not copy is the main camera's own: renderer 0, Base
//     and post-processing on from CameraManager.InitMainCamera, HDR and dithering from the CameraManager prefab, and
//     antialiasing from the game's detail settings (GameConfig.OnUpdateDetailConfig -> SetCameraAntialiasingMode;
//     GameDetailConfigDefaultData has it off at every quality level, as the prefab).
//   - volume mask: SpotCameraController.Setup: SetVolumeMask(LayerMask.GetMask("HomeView")). SpotManager keeps the
//     mask across the ADV boot of a talk (EnsureAfterTalkAdvBootedAsync saves a MainCameraState, RestoreMainCameraState
//     sets it back).
//   - volume stack: the camera's volume update mode is ViaScripting; Fwk.Volume.VolumeManager puts the main camera in
//     its always-update set when it boots (only the full story player, AdvPlayer.Play, takes it out) and calls
//     UpdateVolumeStack for it every PostLateUpdate: VolumeManager.Update(stack, camera transform, HomeView). No game
//     code changes a spot Volume, so the stack is the same in every frame of a talk and the host evaluates it once
//     (spotVolumeStack).
//   - chain: the UI camera is an Overlay camera stacked on the main camera without post-processing
//     (UICameraController.Init), so the main camera's post chain (URPPost: LUT, bloom, uber with the film grain) runs
//     on the spot alone, into the stack's colour target, before the UI camera draws the canvases and the UI blur
//     (UIRenderPass). With antialiasing off no FinalPost runs at the end of the stack.

// LayerMask.NameToLayer("HomeView") in the project's tags and layers
export const HOME_VIEW_LAYER = 15;
export const HOME_VIEW_MASK = 1 << HOME_VIEW_LAYER;

// The main camera in the spot: {near, far, clearFlags, clearColor: [r, g, b, a], orthographic, orthographicSize,
// viewport: {x, y, width, height}, rendererIndex, hdr, antialiasing, dithering, volumeMask} from the CameraManager's
// MainCamera (its Camera and UniversalAdditionalCameraData records in scene.json) and the Spot scene camera (host.json
// home.sceneRoot.sceneCamera, advui camera record; null: none, the main camera keeps its own values).
export const spotMainCamera = (mainCamera, mainData, sceneCamera = null) => {
  const src = sceneCamera ? sceneCamera.camera : mainCamera;
  if (!mainCamera || !src) throw new Error("home spot: the main camera's Camera record is needed");
  const bg = src.m_BackGroundColor, data = mainData || {};
  return { near: src["near clip plane"], far: src["far clip plane"], clearFlags: src.m_ClearFlags,
           clearColor: [bg.r, bg.g, bg.b, bg.a], orthographic: !!src.orthographic, orthographicSize: src["orthographic size"],
           viewport: src.m_NormalizedViewPortRect || null, rendererIndex: 0, hdr: !!mainCamera.m_HDR,
           antialiasing: data.m_Antialiasing || 0, dithering: !!data.m_Dithering, volumeMask: HOME_VIEW_MASK };
};

// The camera settings the spot's drawing does not reproduce: a projection other than perspective, a viewport other
// than the full screen, antialiasing (None 0, FXAA 1, SMAA 2, TAA 3: FinalPost or other passes at the end of the
// stack) and dithering (the uber pass). Raises on the first one set.
export const checkSpotCamera = (cam, what = "home spot") => {
  if (cam.orthographic) throw new Error(`${what}: an orthographic main camera is not implemented`);
  const r = cam.viewport;
  if (r && (r.x !== 0 || r.y !== 0 || r.width !== 1 || r.height !== 1))
    throw new Error(`${what}: a main camera viewport rect other than the full screen is not implemented`);
  if (cam.antialiasing) throw new Error(`${what}: main camera antialiasing mode ${cam.antialiasing} is not implemented`);
  if (cam.dithering) throw new Error(`${what}: main camera dithering is not implemented`);
  return cam;
};

// The spot's Volumes in registration order (Volume.OnEnable): the Spot scene's, loaded before any spot is placed, then
// the placed background prefab's (SpotSceneRoot.SetObject). Records (host.json): {path, active (activeInHierarchy),
// enabled, isGlobal, weight, priority, blendDistance, layer, profile, components: [{class, active, <overridden
// parameter>: value}]}.
export const spotVolumes = (home) =>
  [...((home.sceneRoot && home.sceneRoot.volumes) || []), ...(home.volume ? [home.volume] : [])];

// a profile component of a record in the form URPPost.evaluateStack reads (overridden parameters as
// {m_OverrideState, m_Value}); texture parameters are refused (the host data does not carry the textures)
const profileComponent = (c, where) => {
  const { class: cls, active, ...params } = c;
  const kinds = VOLUME_PARAMS[cls];
  if (!kinds) throw new Error(`${where}: volume component ${cls} not implemented`);
  const out = { asset: cls, active: active ? 1 : 0 };
  for (const [k, v] of Object.entries(params)) {
    if (!kinds[k]) throw new Error(`${where}: ${cls}.${k}: unknown parameter`);
    if (kinds[k] === "n" && VOLUME_DEFAULTS[cls][k] === null)
      throw new Error(`${where}: ${cls}.${k}: texture parameters not implemented`);
    out[k] = { m_OverrideState: 1, m_Value: v };
  }
  return out;
};

// VolumeManager.Update(stack, trigger, layerMask) for the spot: the default state, then the registered volumes whose
// layer is in the mask, sorted by priority (VolumeCollection.SortByPriority: a stable insertion sort), each skipped
// when disabled, without a profile or without weight; a global volume blends by Mathf.Clamp01(weight). A local volume
// (blended by its colliders' distance to the trigger) is refused.
export const spotVolumeStack = (home, mask = HOME_VIEW_MASK, what = "home spot") => {
  const registered = spotVolumes(home).filter((v) => {
    if (typeof v.active !== "boolean") throw new Error(`${what}: Volume ${v.path}: activeInHierarchy is not in the host data`);
    return v.active && v.enabled;
  });
  const grabbed = registered.filter((v) => ((mask >>> v.layer) & 1) === 1);
  const sorted = grabbed.map((v, i) => [v, i]).sort((a, b) => (a[0].priority - b[0].priority) || (a[1] - b[1])).map(([v]) => v);
  const blended = [];
  for (const v of sorted) {
    if (!v.profile || !(v.weight > 0)) continue;
    if (!v.isGlobal) throw new Error(`${what}: local Volume ${v.path} (blend distance ${v.blendDistance}) not implemented`);
    const where = `${what}: Volume ${v.path} profile ${v.profile}`;
    blended.push({ profile: { components: (v.components || []).map((c) => profileComponent(c, where)) }, weight: v.weight });
  }
  return URPPost.evaluateStack(blended);
};

// The parts of a stack the spot camera's chain does not draw: depth of field and motion blur (they read the camera
// depth texture, which the spot does not produce here) and the AdvCurvedLens pass. Raises on the first one active.
export const checkSpotStack = (stack, what = "home spot") => {
  if (URPPost.dofActive(stack)) throw new Error(`${what}: volume depth of field (the camera depth texture) not implemented`);
  if (stack.MotionBlur.intensity > 0) throw new Error(`${what}: volume motion blur (the camera depth texture) not implemented`);
  const C = stack.AdvCurvedLens;
  if (C.intensity > 0 && (C.horizontalRate > 0 || C.verticalRate > 0))
    throw new Error(`${what}: volume AdvCurvedLens not implemented`);
  return stack;
};
