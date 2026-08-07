"""生成 config.yaml 里 auth.password 用的口令散列。

    python -m backend.hashpw '你的密码'
    python -m backend.hashpw            # 不带参数则交互输入，不回显

配置里直接写明文也能用，面板会照常登录。但明文有个具体的坏处：
config.yaml 常会被 cat 出来贴到聊天里排查问题，散列贴出去不算泄漏，明文算。
"""
import getpass
import sys

from .auth import hash_password


def main():
    if len(sys.argv) > 1:
        pw = sys.argv[1]
    else:
        pw = getpass.getpass("密码: ")
        if pw != getpass.getpass("再输一次: "):
            print("两次输入不一致", file=sys.stderr)
            return 1
    if not pw:
        print("密码不能为空", file=sys.stderr)
        return 1
    print()
    print("把下面这行填进 config.yaml 的 auth.password：")
    print()
    print(f'  password: "{hash_password(pw)}"')
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
