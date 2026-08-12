{
  lib,
  stdenvNoCC,
  makeWrapper,
  nodejs,
}:

# Plain Node ESM, no dependencies beyond the runtime.
stdenvNoCC.mkDerivation {
  pname = "kleinanzeigen";
  version = "0.1.0";

  src = ./.;

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    install -Dm644 kleinanzeigen.mjs "$out/libexec/kleinanzeigen.mjs"
    makeWrapper ${lib.getExe nodejs} "$out/bin/kleinanzeigen" \
      --add-flags "$out/libexec/kleinanzeigen.mjs"

    mkdir -p "$out/share/skills"
    cp -r ${./skill} "$out/share/skills/kleinanzeigen"

    runHook postInstall
  '';

  meta = {
    description = "Search kleinanzeigen.de and read/write account messages from the command line";
    mainProgram = "kleinanzeigen";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
