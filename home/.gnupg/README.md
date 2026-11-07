# GPG Token Access Key Setup

This guide covers creating a dedicated GPG key specifically for token access using `pass` (password store).

## Creating New Token Access Key

### Generate GPG Key

```shell
gpg --full-generate-key
gpgconf --kill gpg-agent
```

Get KEY ID:

```shell
gpg --list-keys --keyid-format LONG
```

which yields

```
pub   ed25519/************6910 2026-11-07 [SC] [expires: 2027-05-06]
      ************************************6910
uid                 [ultimate] [name] <email>
sub   cv25519/**************** 2026-11-07 [E] [expires: 2027-05-06]
      ****************************************
```

Use 2nd line of `pub`

## Multi-Machine Setup

```bash
# Export key
$(cd ../../scripts && ./export_gpg_keys KEY_ID)
```

### Import on New Machine

```bash
# Import public key
gpg --import [public-key].asc

# Import private key (from secure backup)
gpg --import [private-key].asc

# Set trust level
gpg --edit-key KEY_ID
gpg> trust
# Choose 5 (ultimate trust)
gpg> save

# Initialize pass
pass init KEY_ID
```

## Passphrase Cache Duration

`gpg-agent` caches passphrases in memory. `pass` inherits this, so prompt frequency is
controlled in `~/.gnupg/gpg-agent.conf`.

```conf
# ~/.gnupg/gpg-agent.conf
pinentry-program /opt/homebrew/bin/pinentry-mac

# cache passphrase 12h (43200s)
default-cache-ttl 43200
max-cache-ttl 43200
default-cache-ttl-ssh 43200
max-cache-ttl-ssh 43200
```

- `default-cache-ttl` — idle timeout, resets on every key use
- `max-cache-ttl` — absolute cap since first cached, cannot be reset by use
- `-ssh` variants apply to SSH keys handled by `gpg-agent`

Set both to n hours for one prompt per n hours regardless of activity. Setting only
`max-cache-ttl` still re-prompts on idle expiry.

Apply changes:

```bash
gpgconf --kill gpg-agent
gpg-connect-agent reloadagent /bye
gpgconf --list-options gpg-agent | grep cache-ttl
```

### pinentry-mac Caveat

`pinentry-mac` stores passphrases in the login Keychain when "Save in keychain" is
checked. Keychain hits bypass `gpg-agent` TTL entirely, so prompts may never appear.

For TTL to work as documented:

1. Uncheck "Save in keychain" in the pinentry dialog (choice is remembered)
2. Delete existing entries:

```bash
security dump-keychain | grep -A2 GnuPG
security delete-generic-password -s GnuPG -a "[name] <email> (KEYID)"
```

Alternatives: `pinentry-curses` (no Keychain layer) or `pinentry-touchid` (biometrics).

## Revocation

```bash
gpg --import /path/to/<FINGERPRINT>.rev
gpg --keyserver keys.openpgp.org --send-keys <FINGERPRINT>   # publish revocation
```

or interactively if no rev key

```bash
gpg --edit-key <KEYID>
# at gpg> prompt:
revkey        # choose reason + description, confirm
save
```

then delete:

```bash
gpg --delete-secret-and-public-key <FINGERPRINT_OR_KEYID>
```

## Links and Resources

- https://dev.to/dnsinyukov/how-to-securely-store-passwords-with-gpg-pass-26d7
- https://bmaingret.github.io/blog/2022-02-15-1Password-gpg-git-seamless-commits-signing
