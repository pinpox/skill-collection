{
  lib,
  fetchFromGitHub,
  python3Packages,
}:

# plann is not in nixpkgs, so we build it here.
#
# Pinned to pinpox/plann rather than upstream pycalendar/plann: the skill relies
# on `caldav_pass_command`, which is still under review upstream in
# https://github.com/pycalendar/plann/pull/46. Repoint `src` at upstream and
# drop the fork once that lands.
let
  version = "1.1.1-unstable-2026-08-13";
in
python3Packages.buildPythonApplication {
  pname = "plann";
  inherit version;
  pyproject = true;

  src = fetchFromGitHub {
    owner = "pinpox";
    repo = "plann";
    rev = "b25a4de7681838f8c519d984ea38c98f1fa7404d";
    hash = "sha256-3yZk4t1BtxeiFP36w3XuyiDHgw2/Pyh41httbm1eq+k=";
  };

  # hatch-vcs derives the version from git metadata, which fetchFromGitHub strips.
  env.SETUPTOOLS_SCM_PRETEND_VERSION = "1.1.2.dev0+gb25a4de";

  build-system = with python3Packages; [
    hatchling
    hatch-vcs
  ];

  dependencies = with python3Packages; [
    caldav
    click
    pyyaml
    sortedcontainers
    dateparser
    icalendar
  ];

  # The test suite spins up a xandikos server on a fixed port; not sandbox-safe.
  doCheck = false;
  pythonImportsCheck = [ "plann.cli" ];

  postInstall = ''
    mkdir -p "$out/share/skills"
    cp -r ${./skill} "$out/share/skills/plann"
  '';

  meta = {
    description = "Command-line CalDAV client and planning tool for calendar items and todo lists";
    homepage = "https://plann.no";
    license = lib.licenses.gpl3Plus;
    mainProgram = "plann";
    platforms = lib.platforms.unix;
  };
}
