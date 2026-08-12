{
  lib,
  config,
  ...
}:
let
  cfg = config.programs.skill-collection;

  registry = import ./skills.nix;

  # Only the "canonical" skills: entries that map 1:1 onto a package of the
  # same name (i.e. no packaging variants).
  allSkills = builtins.filter (name: (registry.${name}.package or name) == name) (
    builtins.attrNames registry
  );
in
{
  imports = [ ./home-manager-common.nix ];

  options.programs.skill-collection = {
    enable = lib.mkEnableOption "skill-collection agent tools";

    skills = lib.mkOption {
      type = lib.types.listOf (lib.types.enum allSkills);
      default = allSkills;
      description = ''
        Which skills to install. Each entry installs the CLI tool into
        `home.packages` and the corresponding skill definition into every
        directory listed in `programs.skill-collection.skillDirs`.

        Defaults to all available skills.
      '';
      example = [ "kleinanzeigen" ];
    };

    package = lib.mkOption {
      type = lib.types.attrsOf lib.types.package;
      description = ''
        Attribute set of skill-collection packages (e.g.
        `inputs.skill-collection.packages.''${system}`).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = map (name: cfg.package.${name}) cfg.skills;

    # Symlink the skill directory shipped inside each package into every
    # configured agent skills directory.
    home.file = lib.listToAttrs (
      lib.concatMap (
        name:
        map (dir: {
          name = "${dir}/${name}";
          value.source = "${cfg.package.${name}}/share/skills/${name}";
        }) cfg.skillDirs
      ) cfg.skills
    );
  };
}
