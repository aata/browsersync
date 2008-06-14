# This script builds the idls in this folder into xpts in <clobber>/components.
# It requires the MOZ_IDL environment variable be set to the path of the idl
# directory which is part of the gecko sdk.

find . | grep \.idl$ | xargs -I {} xpidl -w -m typelib -I $MOZ_IDL {}
mv *.xpt ../components/
