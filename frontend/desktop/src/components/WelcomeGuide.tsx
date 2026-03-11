import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { ChevronRight, ChevronLeft, Check, Sparkles, LayoutDashboard, FileEdit, MessageSquare } from "lucide-react";
import { t } from "../lib/i18n";

interface WelcomeGuideProps {
  onComplete: () => void;
}

export function WelcomeGuide({ onComplete }: WelcomeGuideProps) {
  const [currentStep, setCurrentStep] = useState(0);

  const steps = useMemo(
    () => [
      {
        title: t("onboarding.step0.title"),
        description: t("onboarding.step0.description"),
        icon: <Sparkles className="h-12 w-12 text-primary" />,
        features: [
          { icon: <LayoutDashboard className="h-5 w-5" />, text: t("onboarding.step0.feature1") },
          { icon: <FileEdit className="h-5 w-5" />, text: t("onboarding.step0.feature2") },
          { icon: <MessageSquare className="h-5 w-5" />, text: t("onboarding.step0.feature3") },
        ],
      },
      {
        title: t("onboarding.step1.title"),
        description: t("onboarding.step1.description"),
        icon: <LayoutDashboard className="h-12 w-12 text-emerald-500" />,
      },
      {
        title: t("onboarding.step2.title"),
        description: t("onboarding.step2.description"),
        icon: <MessageSquare className="h-12 w-12 text-violet-500" />,
        quickStart: [
          { title: t("onboarding.step2.quick1Title"), desc: t("onboarding.step2.quick1Desc") },
          { title: t("onboarding.step2.quick2Title"), desc: t("onboarding.step2.quick2Desc") },
          { title: t("onboarding.step2.quick3Title"), desc: t("onboarding.step2.quick3Desc") },
        ],
        shortcutHint: t("onboarding.step2.shortcutHint"),
      },
    ],
    []
  );

  const renderStepBody = () => {
    if (currentStep === 0) {
      return (
        <div className="space-y-3 w-full">
          {currentStepData.features?.map((feature, index) => (
            <motion.div key={index} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.1 }}>
              <Card className="border-border/50 hover:border-primary/50 transition-all">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary">{feature.icon}</div>
                  <span className="text-sm">{feature.text}</span>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      );
    }
    if (currentStep === 1) {
      return (
        <div className="w-full grid grid-cols-3 gap-3">
          <Card className="border-border/60">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">{t("onboarding.step1.left")}</div>
              <div className="mt-1 text-sm font-medium">{t("onboarding.step1.leftLabel")}</div>
            </CardContent>
          </Card>
          <Card className="border-primary/40 bg-primary/5">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">{t("onboarding.step1.center")}</div>
              <div className="mt-1 text-sm font-medium">{t("onboarding.step1.centerLabel")}</div>
            </CardContent>
          </Card>
          <Card className="border-border/60">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">{t("onboarding.step1.right")}</div>
              <div className="mt-1 text-sm font-medium">{t("onboarding.step1.rightLabel")}</div>
            </CardContent>
          </Card>
        </div>
      );
    }
    return (
      <div className="space-y-3 w-full">
        {currentStepData.quickStart?.map((item, index) => (
          <motion.div key={index} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.1 }}>
            <Card className="border-border/50">
              <CardContent className="p-4">
                <div className="text-sm font-medium">{item.title}</div>
                <div className="text-xs text-muted-foreground mt-1">{item.desc}</div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
        <Badge variant="outline" className="text-xs">{currentStepData.shortcutHint}</Badge>
      </div>
    );
  };

  const currentStepData = steps[currentStep];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-100 flex items-center justify-center p-6"
      onClick={(e) => {
        // 点击遮罩背景时关闭引导
        if (e.target === e.currentTarget) {
          onComplete();
        }
      }}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="bg-card rounded-3xl shadow-2xl max-w-3xl w-full border border-border/50 overflow-hidden"
      >
        {/* Progress Bar */}
        <div className="h-1 bg-muted">
          <motion.div
            className="h-full bg-primary"
            initial={{ width: 0 }}
            animate={{ width: `${((currentStep + 1) / steps.length) * 100}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>

        {/* Content */}
        <div className="p-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              {/* Header */}
              <div className="text-center mb-8">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.2, type: "spring" }}
                  className="inline-flex items-center justify-center mb-4"
                >
                  {currentStepData.icon}
                </motion.div>
                <h2 className="text-2xl font-semibold mb-2">{currentStepData.title}</h2>
                <p className="text-muted-foreground">{currentStepData.description}</p>
              </div>

              {/* Step Content */}
              <div className="min-h-[240px] flex items-center justify-center">{renderStepBody()}</div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="border-t border-border/50 p-6 flex items-center justify-between bg-muted/20">
          <div className="flex gap-1.5">
            {steps.map((_, index) => (
              <motion.div
                key={index}
                className={`h-2 rounded-full transition-all ${
                  index === currentStep
                    ? "w-8 bg-primary"
                    : index < currentStep
                    ? "w-2 bg-primary/50"
                    : "w-2 bg-muted-foreground/20"
                }`}
                animate={{ scale: index === currentStep ? 1.2 : 1 }}
              />
            ))}
          </div>

          <div className="flex gap-2">
            {currentStep > 0 && (
              <Button
                variant="outline"
                onClick={() => setCurrentStep(currentStep - 1)}
                className="gap-2"
              >
                <ChevronLeft className="h-4 w-4" />
                {t("onboarding.prev")}
              </Button>
            )}
            
            {currentStep < steps.length - 1 ? (
              <Button onClick={() => setCurrentStep(currentStep + 1)} className="gap-2">
                {t("onboarding.next")}
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={onComplete} className="gap-2">
                <Check className="h-4 w-4" />
                {t("onboarding.start")}
              </Button>
            )}
          </div>
        </div>

        {/* Skip Button */}
        <button
          onClick={onComplete}
          className="absolute top-4 right-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
          aria-label={t("onboarding.skip")}
        >
          {t("onboarding.skip")}
        </button>
      </motion.div>
    </motion.div>
  );
}