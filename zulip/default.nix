{
  lib,
  stdenvNoCC,
  makeWrapper,
  nodejs,
}:

# Plain Node ESM, no dependencies beyond the runtime: the Zulip REST API is
# `fetch` plus HTTP Basic auth.
stdenvNoCC.mkDerivation {
  pname = "zulip";
  version = "0.1.0";

  src = ./.;

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    install -Dm644 zulip.mjs "$out/libexec/zulip.mjs"
    makeWrapper ${lib.getExe nodejs} "$out/bin/zulip" \
      --add-flags "$out/libexec/zulip.mjs"

    mkdir -p "$out/share/skills"
    cp -r ${./skill} "$out/share/skills/zulip"

    runHook postInstall
  '';

  meta = {
    description = "Read and write Zulip chat from the command line";
    mainProgram = "zulip";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
