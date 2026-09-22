"""Verify BRAT delivery without authentication; compare public bytes to a local package."""
import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen


def fetch(url):
    with urlopen(Request(url, headers={'User-Agent': 'Atlas-BRAT-release-check'}), timeout=60) as response:
        return response.read()


def verify(repository, package):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Expected owner/repository')
    local = json.loads((package / 'manifest.json').read_text(encoding='utf-8-sig'))
    api = 'https://api.github.com/repos/' + repository
    repo = json.loads(fetch(api))
    if repo['private']:
        raise ValueError('BRAT package is not public')
    release = json.loads(fetch(api + '/releases/latest'))
    version = local['version']
    if release['tag_name'] != version or release['draft'] or release['prerelease']:
        raise ValueError('Latest stable release does not match local version ' + version)
    raw = f"https://raw.githubusercontent.com/{repository}/{repo['default_branch']}/"
    remote_manifest = json.loads(fetch(raw + 'manifest.json'))
    if remote_manifest != local:
        raise ValueError('Default-branch manifest differs from local package')
    versions = json.loads(fetch(raw + 'versions.json'))
    if versions.get(version) != local['minAppVersion']:
        raise ValueError('Missing or incorrect compatibility entry')
    assets = {asset['name']: asset for asset in release['assets']}
    hashes = {}
    for name in ('main.js', 'manifest.json', 'styles.css'):
        expected = (package / name).read_bytes()
        actual = fetch(assets[name]['browser_download_url'])
        if actual != expected:
            raise ValueError('Public release bytes differ: ' + name)
        hashes[name] = hashlib.sha256(actual).hexdigest()
    return {'repository': repository, 'version': version, 'release': release['html_url'],
            'public_downloads_match': True, 'sha256': hashes, 'phone_installation_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repository')
    parser.add_argument('package', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = json.dumps(verify(args.repository, args.package), indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result, encoding='utf-8')
    print(result)
