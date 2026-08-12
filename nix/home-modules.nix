{ self, lib, ... }:
let
  registry = import ./skills.nix;

  # Base module for one package: installs the CLI and symlinks its skill dir
  # into every configured agent skills directory. Carries a stable `key` so the
  # module system deduplicates it when the same package is pulled in through
  # several skill entries.
  mkBaseModule =
    pkgName:
    { pkgs, config, ... }:
    let
      pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.${pkgName};
      skillDir = "${pkg}/share/skills/${pkgName}";
    in
    {
      key = "skill-collection/base/${pkgName}";
      home.packages = [ pkg ];
      home.file = lib.listToAttrs (
        map (
          dir: lib.nameValuePair "${dir}/${pkgName}" { source = skillDir; }
        ) config.programs.skill-collection.skillDirs
      );
    };

  mkSkillModule =
    name: def:
    let
      pkgName = def.package or name;
      extra = def.extra or (_: { });
    in
    {
      key = "skill-collection/${name}";
      imports = [
        ./home-manager-common.nix
        (mkBaseModule pkgName)
        (extra { inherit self; })
      ];
    };
in
builtins.mapAttrs mkSkillModule registry
