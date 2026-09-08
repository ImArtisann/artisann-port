import { definePlugin } from "@oxlint/plugins";

import noCascadingLayerProvide from "./no-cascading-layer-provide.ts";
import noDirectFetch from "./no-direct-fetch.ts";
import noDisableValidation from "./no-disable-validation.ts";
import noEffectAsVoid from "./no-effect-asvoid.ts";
import noNestedEffectArrayMethods from "./no-nested-effect-array-methods.ts";
import noNestedLayerProvide from "./no-nested-layer-provide.ts";
import noServiceOption from "./no-service-option.ts";
import noShadowedStandardArrayStatic from "./no-shadowed-standard-array-static.ts";
import noSilentErrorSwallow from "./no-silent-error-swallow.ts";
import noStaticEffectServiceForwarders from "./no-static-effect-service-forwarders.ts";
import pipeMaxArguments from "./pipe-max-arguments.ts";
import preferEffectMatch from "./prefer-effect-match.ts";
import preferOptionFromNullable from "./prefer-option-from-nullable.ts";
import requireContextServiceInServices from "./require-context-service-in-services.ts";

/** Effect-focused Oxlint rules that enforce Effect usage conventions. */
const effectPlugin = definePlugin({
    meta: { name: "effect" },
    rules: {
        "no-cascading-layer-provide": noCascadingLayerProvide,
        "no-direct-fetch": noDirectFetch,
        "no-disable-validation": noDisableValidation,
        "no-effect-asvoid": noEffectAsVoid,
        "no-nested-effect-array-methods": noNestedEffectArrayMethods,
        "no-nested-layer-provide": noNestedLayerProvide,
        "no-service-option": noServiceOption,
        "no-shadowed-standard-array-static": noShadowedStandardArrayStatic,
        "no-silent-error-swallow": noSilentErrorSwallow,
        "no-static-effect-service-forwarders": noStaticEffectServiceForwarders,
        "pipe-max-arguments": pipeMaxArguments,
        "prefer-effect-match": preferEffectMatch,
        "prefer-option-from-nullable": preferOptionFromNullable,
        "require-context-service-in-services": requireContextServiceInServices,
    },
});

export default effectPlugin;
