{
  lib,
  stdenvNoCC,
  makeWrapper,
  nodejs,
}:

# Plain Node ESM, no dependencies: the realtime protocol is spoken over Node's
# built-in WebSocket, which needs Node >= 22.
stdenvNoCC.mkDerivation {
  pname = "hedgedoc";
  version = "0.1.0";

  src = ./.;

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    install -Dm644 hd.mjs "$out/libexec/hd.mjs"
    makeWrapper ${lib.getExe nodejs} "$out/bin/hedgedoc" \
      --add-flags "$out/libexec/hd.mjs"

    mkdir -p "$out/share/skills"
    cp -r ${./skill} "$out/share/skills/hedgedoc"

    runHook postInstall
  '';

  meta = {
    description = "Read and edit HedgeDoc/CodiMD notes over the realtime collaboration protocol";
    mainProgram = "hedgedoc";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
